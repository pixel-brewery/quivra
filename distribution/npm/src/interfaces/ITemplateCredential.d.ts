export interface ITemplateCredential {
    name: string;
    kind: "bearer" | "apiKey";
    location: "header" | "query";
    wire_name: string;
}
