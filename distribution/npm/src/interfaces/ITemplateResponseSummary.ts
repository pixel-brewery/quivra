import type { JsonValue } from "../types/JsonValue.js";

export interface ITemplateResponseSummary {
    status: string;
    description: string | null;
    media_types: string[];
    extensions: Record<string, JsonValue>;
}
