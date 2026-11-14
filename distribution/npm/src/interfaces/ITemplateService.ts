import type { ITemplateModelImport } from "./ITemplateModelImport.js";
import type { ITemplateOperation } from "./ITemplateOperation.js";

export interface ITemplateService {
    name: string;
    type_name: string;
    description: string | null;
    operations: ITemplateOperation[];
    imports: ITemplateModelImport[];
}
