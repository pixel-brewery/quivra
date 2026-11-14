import type { IGenerateBatchOptions } from "./interfaces/IGenerateBatchOptions.js";
import { run } from "./run.ts";

export async function generateBatch(options: IGenerateBatchOptions): Promise<void> {
    const flags = [`--out=${options.out}`];
    if (options.check) flags.push("--check");
    await run("generate-batch", { ...options, spec: options.batch }, flags);
}
