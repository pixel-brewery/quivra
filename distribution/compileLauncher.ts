import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function compileLauncher(output: string): void {
    const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
    const project = fileURLToPath(new URL("./npm/tsconfig.json", import.meta.url));
    execFileSync(process.execPath, [compiler, "--project", project, "--outDir", output], {
        stdio: "inherit",
    });
}
