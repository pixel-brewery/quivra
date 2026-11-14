import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { binaryPath } from "./binary.mjs";

const execute = promisify(execFile);
const maxBuffer = 64 * 1024 * 1024;

function argumentsFor(command, options) {
    const args = [command, `--profile=${options.profile}`];
    if (options.referenceRoot !== undefined) {
        args.push(`--reference-root=${options.referenceRoot}`);
    }
    if (command === "generate") {
        args.push(`--out=${options.out}`);
        if (options.check) args.push("--check");
    }
    args.push("--", options.spec);
    return args;
}

export async function generate(options) {
    await execute(binaryPath(), argumentsFor("generate", options), { maxBuffer });
}

export async function inspect(options) {
    const { stdout } = await execute(binaryPath(), argumentsFor("inspect", options), {
        maxBuffer,
    });
    return JSON.parse(stdout);
}
