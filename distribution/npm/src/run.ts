import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { binaryPath } from "./binary.ts";
import type { IInspectOptions } from "./interfaces/IInspectOptions.js";

const execute = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;

export async function run(command: "generate" | "inspect", options: IInspectOptions, flags: string[] = []): Promise<string> {
    const args: string[] = [command, `--profile=${options.profile}`, ...flags];
    if (options.referenceRoot !== undefined) {
        args.push(`--reference-root=${options.referenceRoot}`);
    }
    args.push("--", options.spec);
    const { stdout } = await execute(binaryPath(), args, { maxBuffer });
    return stdout;
}
