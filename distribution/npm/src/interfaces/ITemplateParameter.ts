import type { ITemplateField } from "./ITemplateField.js";

export interface ITemplateParameter extends ITemplateField {
    location: "path" | "query" | "header";
    variable: string;
    style: string | null;
    explode: boolean | null;
    allow_reserved: boolean;
}
