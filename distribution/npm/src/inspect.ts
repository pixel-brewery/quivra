import { run } from "./run.ts";
import type { IInspectOptions } from "./interfaces/IInspectOptions.js";
import type { ITemplateContext } from "./interfaces/ITemplateContext.js";

export async function inspect(options: IInspectOptions): Promise<ITemplateContext> {
    const stdout = await run("inspect", options);
    return JSON.parse(stdout) as ITemplateContext;
}
