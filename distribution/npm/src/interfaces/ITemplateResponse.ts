import type { ITemplateModelImport } from "./ITemplateModelImport.js";

export interface ITemplateResponse {
    status: number | null;
    kind: "json" | "void" | "sse";
    type: string;
    media_type: string | null;
    wire_type: string | null;
    wire_schema_type: string | null;
    schema_name: string | null;
    description: string | null;
    envelope_property: string | null;
    imports: ITemplateModelImport[];
}
