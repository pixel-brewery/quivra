import type { JsonValue } from "../types/JsonValue.js";
import type { ITemplateCredential } from "./ITemplateCredential.js";
import type { ITemplateField } from "./ITemplateField.js";
import type { ITemplateModelImport } from "./ITemplateModelImport.js";
import type { ITemplateOperationVariant } from "./ITemplateOperationVariant.js";
import type { ITemplateParameter } from "./ITemplateParameter.js";
import type { ITemplateResponse } from "./ITemplateResponse.js";
import type { ITemplateResponseSummary } from "./ITemplateResponseSummary.js";

export interface ITemplateOperation {
    id: string;
    raw_id: string;
    tags: string[];
    description: string | null;
    deprecated: boolean;
    imports: ITemplateModelImport[];
    method: string;
    path: string;
    path_parameters: ITemplateField[];
    query_parameters: ITemplateField[];
    header_parameters: ITemplateField[];
    parameters: ITemplateParameter[];
    body_type: string | null;
    body_optional: boolean;
    response_type: string;
    responses: ITemplateResponse[];
    all_responses: ITemplateResponseSummary[];
    variants: ITemplateOperationVariant[];
    path_expression: string;
    success_status: number;
    accept: string | null;
    security: ITemplateCredential[][];
    summary: string | null;
    extensions: Record<string, JsonValue>;
}
