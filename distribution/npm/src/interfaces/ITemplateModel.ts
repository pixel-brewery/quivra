import type { ITemplateField } from "./ITemplateField.js";
import type { ITemplateModelImport } from "./ITemplateModelImport.js";
import type { JsonValue } from "../types/JsonValue.js";

export interface ITemplateModel {
    name: string;
    raw_name: string;
    description: string | null;
    extensions: Record<string, JsonValue>;
    fields: ITemplateField[];
    type_alias: string | null;
    imports: ITemplateModelImport[];
}
