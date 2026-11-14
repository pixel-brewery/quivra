export interface ITemplateResponse {
    status: number | null;
    kind: "json" | "void" | "sse";
    type: string;
    media_type: string | null;
}
