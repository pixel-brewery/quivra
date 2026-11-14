import type { JsonValue } from "../types/JsonValue.js";
import type { ITemplateModel } from "./ITemplateModel.js";
import type { ITemplateModelImport } from "./ITemplateModelImport.js";
import type { ITemplateOperation } from "./ITemplateOperation.js";

/** Context shared by MiniJinja profiles with manifest version 1. */
export interface ITemplateContext {
    api: { title: string };
    models: ITemplateModel[];
    imports: ITemplateModelImport[];
    event_type: string;
    operations: ITemplateOperation[];
    uses_sse: boolean;
    options: Record<string, JsonValue>;
}
