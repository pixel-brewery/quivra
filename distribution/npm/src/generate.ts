import { run } from "./run.ts";
import type { IGenerateOptions } from "./interfaces/IGenerateOptions.js";

export async function generate(options: IGenerateOptions): Promise<void> {
    const flags = [`--out=${options.out}`];
    if (options.check) flags.push("--check");
    await run("generate", options, flags);
}
