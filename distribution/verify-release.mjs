import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { binaryPackageName } from "./npm/src/platform-package.mjs";
import { platforms } from "./platforms.mjs";

const publicRegistry = "https://registry.npmjs.org/";
const cargoVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const distribution = fileURLToPath(new URL(".", import.meta.url));
const npmSource = join(distribution, "npm");
const maxTarOutput = 64 * 1024 * 1024;

function hash(data, algorithm, encoding) {
    return createHash(algorithm).update(data).digest(encoding);
}

function filename(name, version) {
    return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

function tar(file, flags, members = []) {
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

function checkedArchive(file, members) {
    // Only read the expected regular members to stdout. Never extract paths to disk.
    const names = tar(file, "-tzf").toString("utf8").trimEnd().split("\n");
    const types = tar(file, "-tvzf").toString("utf8").trimEnd().split("\n");
    assert.deepEqual(names.sort(), [...members].sort(), `Unexpected entries in ${file}.`);
    assert(types.length === members.length && types.every((line) => line.startsWith("-")),
        `Only regular file entries are allowed in ${file}.`);
    return {
        read: (member) => tar(file, "-xzOf", [member]),
        executable: (member) => {
            const listing = types.find((line) => line.endsWith(` ${member}`));
            assert(listing && listing[3] === "x", `Expected executable mode for ${member} in ${file}.`);
        },
    };
}

async function regularFile(path) {
    assert((await lstat(path)).isFile(), `Expected a regular file at ${path}.`);
}

function readManifest(read, expected, path) {
    const manifest = JSON.parse(read("package/package.json").toString("utf8"));
    assert.deepEqual(manifest, expected, `Unexpected package manifest in ${path}.`);
}

async function launcherEntries() {
    const files = await readdir(npmSource, { recursive: true, withFileTypes: true });
    const entries = new Map([["package/README.md", join(distribution, "..", "docs", "distribution.md")]]);
    for (const file of files) {
        if (file.isDirectory()) continue;
        const path = join(file.parentPath, file.name);
        const member = path.slice(npmSource.length + 1).split(sep).join("/");
        if (member.startsWith("bin/") || member.startsWith("src/")) {
            assert(file.isFile(), `Expected a regular source file at ${path}.`);
            entries.set(`package/${member}`, path);
        }
    }
    return entries;
}

function nativeManifest(launcher, platform, name, version, executable) {
    return {
        name,
        version,
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

function assertNoNpmHooks(manifest) {
    for (const key of ["scripts", "gypfile", "dependencies", "devDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
        assert(!Object.hasOwn(manifest, key), `Release packages must omit ${key}.`);
    }
}

export async function verifyArtifactSet(version, directory) {
    assert(cargoVersionPattern.test(version), "Expected an exact release version such as 0.1.0.");
    const launcher = JSON.parse(await readFile(join(npmSource, "package.json"), "utf8"));
    assert.equal(launcher.name, "@pixel-brewery/quivra");
    assert.equal(launcher.repository.url, "git+https://github.com/pixel-brewery/quivra.git");
    assert.deepEqual(launcher.publishConfig, { registry: publicRegistry, access: "public" });
    assertNoNpmHooks(launcher);

    const native = platforms.map((platform) => {
        const name = binaryPackageName(launcher.name, platform.os, platform.cpu);
        const archive = `quivra-${version}-${platform.target}.tar.gz`;
        return { platform, name, npm: filename(name, version), archive, sidecar: `${archive}.sha256` };
    });
    const launcherFile = filename(launcher.name, version);
    const expectedNames = [launcherFile, ...native.flatMap(({ npm, archive, sidecar }) => [npm, archive, sidecar])].sort();
    assert.deepEqual((await readdir(directory)).sort(), expectedNames, "Unexpected release artifact names.");
    await Promise.all(expectedNames.map((name) => regularFile(join(directory, name))));

    const packages = [];
    for (const { platform, name, npm, archive, sidecar } of native) {
        const npmPath = join(directory, npm);
        const archivePath = join(directory, archive);
        const executable = platform.os === "win32" ? "quivra.exe" : "quivra";
        const npmBinary = `package/${executable}`;
        const npmPackage = checkedArchive(npmPath, ["package/package.json", npmBinary]);
        const releaseArchive = checkedArchive(archivePath, [executable]);
        if (platform.os !== "win32") {
            npmPackage.executable(npmBinary);
            releaseArchive.executable(executable);
        }
        readManifest(npmPackage.read, nativeManifest(launcher, platform, name, version, executable), npmPath);

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
    const members = await launcherEntries();
    const launcherPackage = checkedArchive(launcherPath, ["package/package.json", ...members.keys()]);
    launcherPackage.executable("package/bin/quivra.mjs");
    const expectedLauncher = {
        ...launcher,
        version,
        optionalDependencies: Object.fromEntries(native.map(({ name }) => [name, version])),
    };
    delete expectedLauncher.private;
    readManifest(launcherPackage.read, expectedLauncher, launcherPath);
    for (const [member, source] of members) {
        assert(launcherPackage.read(member).equals(await readFile(source)), `Packed ${member} differs from the source.`);
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

async function registryIntegrity({ name, version }, fetchMetadata = fetch) {
    const versionUrl = new URL(`${encodeURIComponent(name)}/${version}`, publicRegistry);
    const response = await fetchMetadata(versionUrl, {
        headers: { accept: "application/json", "cache-control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
    });
    const label = `${name}@${version}`;
    if (response.status === 404) {
        const body = await response.json();
        const reason = typeof body === "string" ? body : body?.error;
        assert(
            reason === "Not Found" || reason === "not_found" || reason === `version not found: ${version}`,
            `npm registry returned an unexpected absence response for ${label}.`,
        );
        return null;
    }
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status} for ${label}.`);
    const published = await response.json();
    assert(published.name === name && published.version === version,
        `npm registry returned unexpected package identity for ${label}.`);
    const integrity = published.dist?.integrity;
    assert(typeof integrity === "string" && integrity.length > 0,
        `npm registry has no integrity for ${label}.`);
    return integrity;
}

export async function publishCheckedPackages(packages, {
    publish,
    fetchMetadata = fetch,
    pause = delay,
}) {
    assert.equal(typeof publish, "function", "A publication callback is required.");
    // Check the entire release first so a collision in a later package prevents earlier writes.
    const published = await Promise.all(packages.map((entry) => registryIntegrity(entry, fetchMetadata)));
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
            const integrity = await registryIntegrity(entry, fetchMetadata);
            if (integrity !== null) {
                assert.equal(integrity, entry.integrity, `npm published different tarball bytes for ${label}.`);
                break;
            }
            if (attempt === 9) throw new Error(`npm did not expose ${label} after publishing. Retry this workflow with the same artifacts.`);
            await pause(2_000);
        }
    }
}

function requireReleaseWorkflow() {
    assert(
        process.env.GITHUB_ACTIONS === "true"
            && process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
            && process.env.GITHUB_REPOSITORY === "pixel-brewery/quivra"
            && process.env.GITHUB_REPOSITORY_ID === "1457527723"
            && process.env.GITHUB_REF === "refs/heads/main"
            && process.env.GITHUB_WORKFLOW_REF === "pixel-brewery/quivra/.github/workflows/release.yml@refs/heads/main"
            && process.env.ACTIONS_ID_TOKEN_REQUEST_URL
            && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
        "npm publication requires Quivra's GitHub Actions release workflow and OIDC.",
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [version, directory, mode, ...extra] = process.argv.slice(2);
    if (!version || !directory || (mode !== undefined && mode !== "--publish-npm") || extra.length > 0) {
        throw new Error("Usage: node distribution/verify-release.mjs VERSION ARTIFACTS [--publish-npm]");
    }
    if (mode === "--publish-npm") requireReleaseWorkflow();
    const packages = await verifyArtifactSet(version, resolve(directory));
    if (mode === "--publish-npm") {
        await publishCheckedPackages(packages, {
            publish: (file) => execFileSync("npm", [
                "publish", file, "--ignore-scripts", "--access", "public", "--registry", publicRegistry,
            ], { stdio: "inherit", timeout: 120_000 }),
        });
    }
}
