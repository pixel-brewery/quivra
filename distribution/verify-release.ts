import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryPackageName } from "./npm/src/platform-package.ts";
import { platforms } from "./platforms.ts";
import { compileLauncher } from "./compileLauncher.ts";
import { readLauncherManifest } from "./readLauncherManifest.ts";
import { schemaFiles } from "./schema-files.ts";

const packageRegistry = "https://npm.pkg.github.com";
const githubApi = "https://api.github.com";
const organization = "pixel-brewery";
const canonicalRepository = `${organization}/quivra`;
const repositoryId = 1457527723;
const metadataBudget = 4 * 1024 * 1024;
const archiveBudget = 64 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const cargoVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const distribution = fileURLToPath(new URL(".", import.meta.url));
const maxTarOutput = 64 * 1024 * 1024;

function hash(data: Buffer, algorithm: string, encoding: "hex" | "base64") {
    return createHash(algorithm).update(data).digest(encoding);
}

function filename(name: string, version: string) {
    return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

function tar(file: string, flags: string, members: string[] = []) {
    try {
        return execFileSync("tar", [flags, file, "--", ...members], {
            maxBuffer: maxTarOutput,
            windowsHide: true,
            env: { ...process.env, LC_ALL: "C", TAR_OPTIONS: "" },
        });
    } catch (cause) {
        throw new Error(`Could not read archive ${file}.`, { cause });
    }
}

function checkedArchive(file: string, members: Iterable<string>) {
    // Only read the expected regular members to stdout. Never extract paths to disk.
    const names = tar(file, "-tzf").toString("utf8").trimEnd().split("\n");
    const types = tar(file, "-tvzf").toString("utf8").trimEnd().split("\n");
    const expected = [...members].sort();
    assert.deepEqual(names.sort(), expected, `Unexpected entries in ${file}.`);
    assert(types.length === expected.length && types.every((line) => line.startsWith("-")),
        `Only regular file entries are allowed in ${file}.`);
    return {
        read: (member: string) => tar(file, "-xzOf", [member]),
        executable: (member: string) => {
            const listing = types.find((line) => line.endsWith(` ${member}`));
            assert(listing && listing[3] === "x", `Expected executable mode for ${member} in ${file}.`);
        },
    };
}

async function regularFile(path: string) {
    assert((await lstat(path)).isFile(), `Expected a regular file at ${path}.`);
}

function readManifest(read: (member: string) => Buffer, expected: object, path: string) {
    const manifest = JSON.parse(read("package/package.json").toString("utf8"));
    assert.deepEqual(manifest, expected, `Unexpected package manifest in ${path}.`);
}

async function launcherEntries(license: Buffer): Promise<Map<string, Buffer>> {
    const staging = await mkdtemp(join(tmpdir(), "quivra-launcher-"));
    try {
        compileLauncher(staging);
        const files = await readdir(staging, { recursive: true, withFileTypes: true });
        const entries = new Map([
            ["package/README.md", await readFile(join(distribution, "..", "docs", "distribution.md"))],
            ["package/LICENSE", license],
        ]);
        for (const file of schemaFiles) {
            entries.set(`package/schemas/${file}`, await readFile(join(distribution, "..", "schemas", file)));
        }
        for (const file of files) {
            if (file.isDirectory()) continue;
            const path = join(file.parentPath, file.name);
            const member = path.slice(staging.length + 1).split(sep).join("/");
            assert(file.isFile(), `Expected a regular generated file at ${path}.`);
            entries.set(`package/dist/${member}`, await readFile(path));
        }
        return entries;
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

type LauncherManifest = Awaited<ReturnType<typeof readLauncherManifest>>;
type Platform = (typeof platforms)[number];

interface IPackageArtifact {
    name: string;
    path: string;
    version: string;
    integrity: string;
}

function nativeManifest(launcher: LauncherManifest, platform: Platform, name: string, version: string, executable: string) {
    return {
        name,
        version,
        license: launcher.license,
        description: `Quivra executable for ${platform.os}/${platform.cpu}`,
        repository: launcher.repository,
        homepage: launcher.homepage,
        bugs: launcher.bugs,
        publishConfig: launcher.publishConfig,
        os: [platform.os],
        cpu: [platform.cpu],
        ...(platform.libc ? { libc: [platform.libc] } : {}),
        files: [executable],
    };
}

function assertNoNpmHooks(manifest: object) {
    for (const key of ["scripts", "gypfile", "dependencies", "devDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
        assert(!Object.hasOwn(manifest, key), `Release packages must omit ${key}.`);
    }
}

export async function verifyArtifactSet(version: string, directory: string): Promise<IPackageArtifact[]> {
    assert(cargoVersionPattern.test(version), "Expected an exact release version such as 0.1.0.");
    const launcher = await readLauncherManifest();
    assert.equal(launcher.name, "@pixel-brewery/quivra");
    assert.equal(launcher.repository.url, "git+https://github.com/pixel-brewery/quivra.git");
    assert.deepEqual(launcher.publishConfig, { registry: packageRegistry, access: "public" });
    assertNoNpmHooks(launcher);
    const license = await readFile(new URL("../LICENSE", import.meta.url));

    const native = platforms.map((platform) => {
        const name = binaryPackageName(launcher.name, platform.os, platform.cpu);
        const archive = `quivra-${version}-${platform.target}.tar.gz`;
        return { platform, name, npm: filename(name, version), archive, sidecar: `${archive}.sha256` };
    });
    const launcherFile = filename(launcher.name, version);
    const expectedNames = [launcherFile, ...native.flatMap(({ npm, archive, sidecar }) => [npm, archive, sidecar])].sort();
    assert.deepEqual((await readdir(directory)).sort(), expectedNames, "Unexpected release artifact names.");
    await Promise.all(expectedNames.map((name) => regularFile(join(directory, name))));

    const packages: IPackageArtifact[] = [];
    for (const { platform, name, npm, archive, sidecar } of native) {
        const npmPath = join(directory, npm);
        const archivePath = join(directory, archive);
        const executable = platform.os === "win32" ? "quivra.exe" : "quivra";
        const npmBinary = `package/${executable}`;
        const npmPackage = checkedArchive(npmPath, ["package/package.json", npmBinary, "package/LICENSE"]);
        const releaseArchive = checkedArchive(archivePath, [executable, "LICENSE"]);
        if (platform.os !== "win32") {
            npmPackage.executable(npmBinary);
            releaseArchive.executable(executable);
        }
        readManifest(npmPackage.read, nativeManifest(launcher, platform, name, version, executable), npmPath);

        assert(npmPackage.read("package/LICENSE").equals(license) && releaseArchive.read("LICENSE").equals(license),
            `License differs from the source in ${npm} or ${archive}.`);
        const binary = npmPackage.read(npmBinary);
        assert(binary.length > 0 && binary.equals(releaseArchive.read(executable)),
            `Executables differ between ${npm} and ${archive}.`);
        const digest = hash(await readFile(archivePath), "sha256", "hex");
        assert.equal(await readFile(join(directory, sidecar), "utf8"), `${digest}  ${archive}\n`,
            `Checksum mismatch for ${archive}.`);
        packages.push({
            name,
            path: npmPath,
            version,
            integrity: `sha512-${hash(await readFile(npmPath), "sha512", "base64")}`,
        });
    }

    const launcherPath = join(directory, launcherFile);
    const members = await launcherEntries(license);
    const launcherPackage = checkedArchive(launcherPath, ["package/package.json", ...members.keys()]);
    launcherPackage.executable("package/dist/bin/quivra.js");
    const expectedLauncher = {
        ...launcher,
        version,
        optionalDependencies: Object.fromEntries(native.map(({ name }) => [name, version])),
    };
    delete expectedLauncher.private;
    readManifest(launcherPackage.read, expectedLauncher, launcherPath);
    for (const [member, source] of members) {
        assert(launcherPackage.read(member).equals(source), `Packed ${member} differs from the source.`);
    }
    packages.push({
        name: launcher.name,
        path: launcherPath,
        version,
        integrity: `sha512-${hash(await readFile(launcherPath), "sha512", "base64")}`,
    });

    console.log(`Verified ${expectedNames.length} release artifacts for v${version}.`);
    return packages;
}

function record(value: unknown): Record<string, unknown> | undefined {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

async function readMetadata(response: Response): Promise<unknown> {
    assert(response.body, "GitHub Packages returned an empty metadata response.");
    assert(Number(response.headers.get("content-length")) <= metadataBudget,
        "GitHub Packages metadata exceeds its byte budget.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            assert(length <= metadataBudget, "GitHub Packages metadata exceeds its byte budget.");
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length)));
}

function packageSlug(name: string): string {
    const prefix = `@${organization}/`;
    assert(name.startsWith(prefix) && /^quivra(?:-[a-z0-9-]+)?$/u.test(name.slice(prefix.length)),
        `Unexpected GitHub package name ${name}.`);
    return name.slice(prefix.length);
}

function requestMetadata(url: string, token: string, fetchMetadata: typeof fetch): Promise<Response> {
    const rest = new URL(url).origin === githubApi;
    return fetchMetadata(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: rest ? "application/vnd.github+json" : "application/json",
            "Cache-Control": "no-cache",
            "User-Agent": "Quivra-release",
            ...(rest ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
    });
}

async function readRegistryVersion(
    { name, version }: IPackageArtifact, token: string, fetchMetadata: typeof fetch,
): Promise<{ integrity: string; tarball: string } | null> {
    const slug = packageSlug(name);
    const response = await requestMetadata(`${packageRegistry}/@${organization}%2f${slug}`, token, fetchMetadata);
    const label = `${name}@${version}`;
    if (response.status === 404) {
        const problem = record(await readMetadata(response));
        assert.equal(problem?.error, `npm package "${slug}" does not exist under owner "${organization}"`,
            `GitHub Packages returned an unexpected absence response for ${label}.`);
        return null;
    }
    assert(response.ok, `GitHub Packages returned HTTP ${response.status} for ${label}.`);
    const packageInfo = record(await readMetadata(response));
    const versions = record(packageInfo?.versions);
    assert(packageInfo?.name === name && versions,
        `GitHub Packages returned unexpected package metadata for ${label}.`);
    if (!Object.hasOwn(versions, version)) return null;
    const published = record(versions[version]);
    assert(published?.name === name && published.version === version,
        `GitHub Packages returned unexpected version identity for ${label}.`);
    const dist = record(published.dist);
    const integrity = dist?.integrity;
    const tarball = dist?.tarball;
    assert(typeof integrity === "string" && /^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity),
        `GitHub Packages has no SHA-512 integrity for ${label}.`);
    assert(typeof tarball === "string", `GitHub Packages has no archive URL for ${label}.`);
    return { integrity, tarball };
}

function archiveUrl(value: string, base?: URL): URL {
    const url = new URL(value, base);
    assert(url.protocol === "https:" && ["npm.pkg.github.com", "pkg-npm.githubusercontent.com"].includes(url.hostname)
        && !url.port && !url.username && !url.password && !url.hash,
        "GitHub Packages redirected to an unexpected archive URL.");
    return url;
}

async function downloadedIntegrity(
    entry: IPackageArtifact, tarball: string, token: string, fetchMetadata: typeof fetch,
): Promise<string> {
    let url = archiveUrl(tarball);
    assert(url.origin === packageRegistry && url.pathname.startsWith(`/download/${entry.name}/${entry.version}/`)
        && !url.search, `GitHub Packages returned an unexpected archive path for ${entry.name}.`);
    let sendToken = true;
    const signal = AbortSignal.timeout(30_000);
    let response: Response;
    for (let redirects = 0; ; redirects++) {
        response = await fetchMetadata(url, {
            headers: {
                Accept: "application/octet-stream",
                ...(sendToken ? { Authorization: `Bearer ${token}` } : {}),
            },
            redirect: "manual",
            signal,
        });
        if (!redirectStatuses.has(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        assert(redirects < 3 && location && location.length <= 8192,
            "GitHub Packages returned an unexpected archive redirect.");
        const next = archiveUrl(location, url);
        sendToken = sendToken && next.origin === url.origin;
        url = next;
    }
    assert(response.ok && response.body && Number(response.headers.get("content-length")) <= archiveBudget,
        `Could not download bounded GitHub Packages archive for ${entry.name} (HTTP ${response.status}).`);
    const reader = response.body.getReader();
    const digest = createHash("sha512");
    let length = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            assert(length <= archiveBudget, "GitHub Packages archive exceeds its byte budget.");
            digest.update(value);
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    return `sha512-${digest.digest("base64")}`;
}

export async function verifyPublicPackages(
    packages: readonly IPackageArtifact[], token: string, fetchMetadata = fetch,
): Promise<void> {
    const privatePackages: string[] = [];
    for (const entry of packages) {
        const slug = packageSlug(entry.name);
        const label = `${entry.name}@${entry.version}`;
        const response = await requestMetadata(
            `${githubApi}/orgs/${organization}/packages/npm/${slug}`, token, fetchMetadata,
        );
        assert(response.ok, `GitHub package access metadata returned HTTP ${response.status} for ${label}.`);
        const packageInfo = record(await readMetadata(response));
        const repository = record(packageInfo?.repository);
        assert(
            packageInfo?.name === slug && packageInfo.package_type === "npm" &&
            record(packageInfo.owner)?.login === organization &&
            repository?.id === repositoryId && repository.full_name === canonicalRepository &&
            repository.private === false,
            `GitHub package ${label} is not linked to the canonical Quivra repository.`,
        );
        const version = await readRegistryVersion(entry, token, fetchMetadata);
        assert(version, `GitHub Packages has no published version for ${label}.`);
        assert.equal(version.integrity, entry.integrity, `Published archive integrity differs for ${label}.`);
        if (packageInfo.visibility !== "public") {
            privatePackages.push(`https://github.com/orgs/${organization}/packages/npm/package/${slug}`);
        } else {
            assert.equal(await downloadedIntegrity(entry, version.tarball, token, fetchMetadata), entry.integrity,
                `Downloaded archive bytes differ for ${label}.`);
        }
    }
    assert(privatePackages.length === 0,
        `Set these GitHub Packages to Public in their package settings, then re-run failed jobs on this release:\n${privatePackages.join("\n")}`);
    console.log(`Verified ${packages.length} public GitHub packages connected to ${canonicalRepository}.`);
}

interface IPublishOptions {
    token: string;
    publish: (file: string) => unknown;
    fetchMetadata?: typeof fetch;
    pause?: (milliseconds: number) => Promise<unknown>;
}

export async function publishCheckedPackages(packages: readonly IPackageArtifact[], {
    token,
    publish,
    fetchMetadata = fetch,
    pause = delay,
}: IPublishOptions): Promise<void> {
    assert.equal(typeof publish, "function", "A publication callback is required.");
    // Check the entire release first so a collision in a later package prevents earlier writes.
    const published = await Promise.all(packages.map(async (entry) => (await readRegistryVersion(entry, token, fetchMetadata))?.integrity ?? null));
    for (const [index, entry] of packages.entries()) {
        if (published[index] !== null) {
            assert.equal(published[index], entry.integrity,
                `${entry.name}@${entry.version} already exists with different tarball bytes.`);
        }
    }

    for (const [index, entry] of packages.entries()) {
        const label = `${entry.name}@${entry.version}`;
        if (published[index] !== null) {
            console.log(`Already published with identical bytes: ${label}`);
            continue;
        }
        const actual = `sha512-${hash(await readFile(entry.path), "sha512", "base64")}`;
        assert.equal(actual, entry.integrity, `Verified tarball changed: ${entry.path}`);
        await publish(entry.path);
        for (let attempt = 0; attempt < 10; attempt++) {
            const integrity = (await readRegistryVersion(entry, token, fetchMetadata))?.integrity ?? null;
            if (integrity !== null) {
                assert.equal(integrity, entry.integrity, `npm published different tarball bytes for ${label}.`);
                break;
            }
            if (attempt === 9) throw new Error(`npm did not expose ${label} after publishing. Retry this workflow with the same artifacts.`);
            await pause(2_000);
        }
    }
}

function requireReleaseWorkflow(): string {
    const token = process.env.NODE_AUTH_TOKEN;
    assert(
        process.env.GITHUB_ACTIONS === "true"
            && process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
            && process.env.GITHUB_REPOSITORY === canonicalRepository
            && process.env.GITHUB_REPOSITORY_ID === String(repositoryId)
            && process.env.GITHUB_REF === "refs/heads/main"
            && process.env.GITHUB_WORKFLOW_REF === `${canonicalRepository}/.github/workflows/release.yml@refs/heads/main`
            && token,
        "Package publication requires Quivra's GitHub Actions release workflow and its package token.",
    );
    return token;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [version, directory, mode, ...extra] = process.argv.slice(2);
    if (!version || !directory || (mode !== undefined && mode !== "--publish-npm" && mode !== "--verify-public") || extra.length > 0) {
        throw new Error("Usage: node distribution/verify-release.ts VERSION ARTIFACTS [--publish-npm | --verify-public]");
    }
    const token = mode === "--publish-npm" ? requireReleaseWorkflow() : process.env.NODE_AUTH_TOKEN;
    const packages = await verifyArtifactSet(version, resolve(directory));
    if (mode === "--publish-npm") {
        assert(token);
        await publishCheckedPackages(packages, {
            token,
            publish: (file) => execFileSync("npm", [
                "publish", file, "--ignore-scripts", "--registry", packageRegistry,
            ], { stdio: "inherit", timeout: 120_000 }),
        });
    } else if (mode === "--verify-public") {
        assert(token, "An existing GitHub Packages read token is required in NODE_AUTH_TOKEN.");
        await verifyPublicPackages(packages, token);
    }
}
