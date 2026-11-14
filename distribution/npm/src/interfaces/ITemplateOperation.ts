import type { JsonValue } from "../types/JsonValue.js";
import type { ITemplateCredential } from "./ITemplateCredential.js";
import type { ITemplateField } from "./ITemplateField.js";
import type { ITemplateModelImport } from "./ITemplateModelImport.js";
import type { ITemplateResponse } from "./ITemplateResponse.js";

export interface ITemplateOperation {
    id: string;
    imports: ITemplateModelImport[];
    method: string;
    path: string;
    path_parameters: ITemplateField[];
    query_parameters: ITemplateField[];
    body_type: string | null;
    body_optional: boolean;
    response_type: string;
    responses: ITemplateResponse[];
    accept: string | null;
    security: ITemplateCredential[][];
    summary: string | null;
    extensions: Record<string, JsonValue>;
}
