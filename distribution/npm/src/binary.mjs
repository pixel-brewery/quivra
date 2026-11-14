import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { binaryPackageName } from "./platform-package.mjs";

const require = createRequire(import.meta.url);

export function binaryPath() {
    const { name: launcherName, optionalDependencies, version } = require("../package.json");
    const name = binaryPackageName(launcherName, process.platform, process.arch);

    if (!Object.hasOwn(optionalDependencies ?? {}, name)) {
        throw new Error(`No Quivra binary is packaged for ${process.platform}/${process.arch}.`);
    }

    const manifestName = `${name}/package.json`;
    let manifestPath;
    try {
        manifestPath = require.resolve(manifestName);
    } catch (error) {
        if (error.code !== "MODULE_NOT_FOUND") throw error;
        throw new Error(
            `Missing Quivra binary package ${name}@${version}. ` +
            "Install with optional dependencies enabled on a supported system.",
            { cause: error },
        );
    }

    if (require(manifestPath).version !== version) {
        throw new Error(`Quivra requires ${name}@${version}; reinstall to restore matching versions.`);
    }
    return join(dirname(manifestPath), process.platform === "win32" ? "quivra.exe" : "quivra");
}
