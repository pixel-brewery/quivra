import type { ITemplateRequestBody } from "./ITemplateRequestBody.js";
import type { ITemplateResponse } from "./ITemplateResponse.js";

export interface ITemplateOperationVariant {
    name: string;
    request_body: ITemplateRequestBody | null;
    response: ITemplateResponse | null;
}
