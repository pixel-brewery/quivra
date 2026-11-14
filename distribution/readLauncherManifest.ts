import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

interface ILauncherManifest {
    readonly name: string;
    readonly private?: boolean;
    readonly repository: { readonly url: string };
    readonly homepage: string;
    readonly bugs: { readonly url: string };
    readonly publishConfig: { readonly registry: string; readonly access: string };
}

export async function readLauncherManifest(): Promise<ILauncherManifest> {
    const source = new URL("./npm/package.json", import.meta.url);
    const manifest: unknown = JSON.parse(await readFile(source, "utf8"));
    assert(manifest && typeof manifest === "object");
    assert("name" in manifest && typeof manifest.name === "string");
    assert("repository" in manifest && manifest.repository && typeof manifest.repository === "object");
    assert("url" in manifest.repository && typeof manifest.repository.url === "string");
    assert("homepage" in manifest && typeof manifest.homepage === "string");
    assert("bugs" in manifest && manifest.bugs && typeof manifest.bugs === "object");
    assert("url" in manifest.bugs && typeof manifest.bugs.url === "string");
    assert("publishConfig" in manifest && manifest.publishConfig && typeof manifest.publishConfig === "object");
    assert("registry" in manifest.publishConfig && typeof manifest.publishConfig.registry === "string");
    assert("access" in manifest.publishConfig && typeof manifest.publishConfig.access === "string");
    assert(!("private" in manifest) || typeof manifest.private === "boolean");
    return manifest as ILauncherManifest;
}
