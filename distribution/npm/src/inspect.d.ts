import type { IInspectOptions } from "./interfaces/IInspectOptions.js";
import type { ITemplateContext } from "./interfaces/ITemplateContext.js";

export function inspect(options: IInspectOptions): Promise<ITemplateContext>;
