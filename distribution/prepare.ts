import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryPackageName } from "./npm/src/platform-package.ts";
import { platforms } from "./platforms.ts";

import { compileLauncher } from "./compileLauncher.ts";
import { readLauncherManifest } from "./readLauncherManifest.ts";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const launcher = await readLauncherManifest();
const [command, targetOrOutput, binaryArgument, nativeOutput, ...extra] = process.argv.slice(2);
const npmPlatforms = platforms.map((platform) => {
    const npmName = binaryPackageName(launcher.name, platform.os, platform.cpu);
    return {
        ...platform,
        npm_name: npmName,
        npm_tarball_prefix: npmName.slice(1).replace("/", "-"),
    };
});

async function writeManifest(output: string, manifest: object) {
    await writeFile(join(output, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
}

function cargoVersion(): string {
    const metadata: unknown = JSON.parse(execFileSync(
        "cargo",
        ["metadata", "--locked", "--no-deps", "--format-version", "1"],
        { cwd: sourceRoot, encoding: "utf8" },
    ));
    if (!metadata || typeof metadata !== "object" || !("packages" in metadata) || !Array.isArray(metadata.packages)) {
        throw new Error("Cargo returned invalid package metadata.");
    }
    const packages: unknown[] = metadata.packages;
    const quivra = packages.find((entry) =>
        entry !== null && typeof entry === "object" && "name" in entry && entry.name === "quivra",
    );
    if (!quivra || typeof quivra !== "object" || !("version" in quivra) || typeof quivra.version !== "string") {
        throw new Error("Cargo metadata has no Quivra package version.");
    }
    return quivra.version;
}

if (command === "matrix" && targetOrOutput === undefined) {
    console.log(JSON.stringify({ include: npmPlatforms }));
} else if (command === "launcher" && targetOrOutput !== undefined && binaryArgument === undefined) {
    const output = resolve(targetOrOutput);
    const version = cargoVersion();
    const optionalDependencies = Object.fromEntries(npmPlatforms.map((platform) => [platform.npm_name, version]));
    const manifest = { ...launcher, version, optionalDependencies, private: undefined };

    await mkdir(output, { recursive: true });
    compileLauncher(join(output, "dist"));
    await chmod(join(output, "dist", "bin", "quivra.js"), 0o755);
    await copyFile(join(sourceRoot, "docs", "distribution.md"), join(output, "README.md"));
    await writeManifest(output, manifest);
} else if (command === "native" && binaryArgument !== undefined && nativeOutput !== undefined && extra.length === 0) {
    const platform = npmPlatforms.find((entry) => entry.target === targetOrOutput);
    if (platform === undefined) {
        throw new Error(`Unknown Rust release target ${targetOrOutput}.`);
    }
    if (platform.os !== process.platform || platform.cpu !== process.arch) {
        throw new Error(`Prepare ${platform.target} on its native runner.`);
    }

    const version = cargoVersion();
    const binary = resolve(binaryArgument);
    const foundVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
    if (foundVersion !== `quivra ${version}`) {
        throw new Error(`Expected quivra ${version} but ${binary} reports ${foundVersion}.`);
    }

    const output = resolve(nativeOutput);
    const binaryName = platform.os === "win32" ? "quivra.exe" : "quivra";
    const manifest = {
        name: platform.npm_name,
        version,
        description: `Quivra executable for ${platform.os}/${platform.cpu}`,
        repository: launcher.repository,
        homepage: launcher.homepage,
        bugs: launcher.bugs,
        publishConfig: launcher.publishConfig,
        os: [platform.os],
        cpu: [platform.cpu],
        ...(platform.libc ? { libc: [platform.libc] } : {}),
        files: [binaryName],
    };
    await mkdir(output, { recursive: true });
    const executable = join(output, binaryName);
    await copyFile(binary, executable);
    await chmod(executable, 0o755);
    await writeManifest(output, manifest);
} else {
    console.error(
        "Usage: node distribution/prepare.ts matrix\n" +
        "       node distribution/prepare.ts launcher <output-directory>\n" +
        "       node distribution/prepare.ts native <rust-target> <binary> <output-directory>",
    );
    process.exitCode = 1;
}
