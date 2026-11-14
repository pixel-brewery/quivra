import { generate, inspect, type ITemplateContext, type ITemplateModelImport } from "@pixel-brewery/quivra";

export async function example(): Promise<ITemplateContext> {
    const input = { spec: "openapi.yaml", profile: "profiles/fetch", referenceRoot: "." };
    const context = await inspect(input);
    const imports: ITemplateModelImport[] = [
        ...context.imports,
        ...context.models.flatMap((model) => model.imports),
        ...context.operations.flatMap((operation) => operation.imports),
    ];
    if (!context.api.title || !context.event_type || imports.some((entry) => !entry.name)) {
        throw new Error("Expected a complete template context.");
    }
    await generate({ ...input, out: "src/api", check: true });
    return context;
}

// @ts-expect-error Spec paths are strings.
export const invalidInspect = () => inspect({ spec: false, profile: "profiles/fetch" });
