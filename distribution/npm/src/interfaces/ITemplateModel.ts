import type { ITemplateField } from "./ITemplateField.js";
import type { ITemplateModelImport } from "./ITemplateModelImport.js";

export interface ITemplateModel {
    name: string;
    fields: ITemplateField[];
    type_alias: string | null;
    imports: ITemplateModelImport[];
}
