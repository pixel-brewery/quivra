import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { binaryPackageName } from "./platform-package.ts";

const require = createRequire(import.meta.url);

interface ILauncherManifest {
    name: string;
    version: string;
    optionalDependencies: Record<string, string>;
}

export function binaryPath(): string {
    const manifest = require("../../package.json") as ILauncherManifest;
    const { name: launcherName, optionalDependencies, version } = manifest;
    const name = binaryPackageName(launcherName, process.platform, process.arch);

    if (!Object.hasOwn(optionalDependencies ?? {}, name)) {
        throw new Error(`No Quivra binary is packaged for ${process.platform}/${process.arch}.`);
    }

    let manifestPath: string;
    try {
        manifestPath = require.resolve(`${name}/package.json`);
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "MODULE_NOT_FOUND") throw error;
        throw new Error(
            `Missing Quivra binary package ${name}@${version}. ` +
            "Install with optional dependencies enabled on a supported system.",
            { cause: error },
        );
    }

    const nativeManifest = require(manifestPath) as Pick<ILauncherManifest, "version">;
    if (nativeManifest.version !== version) {
        throw new Error(`Quivra requires ${name}@${version}; reinstall to restore matching versions.`);
    }
    return join(dirname(manifestPath), process.platform === "win32" ? "quivra.exe" : "quivra");
}
