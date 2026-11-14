# Profiles

A profile is a JSON manifest and its MiniJinja templates. Copy either example or use `quivra init --preset fetch|transport --out <directory>`. Each file in the copy is yours to edit. `--profile` accepts either a directory with a `profile.json` or the path to a manifest.

```json
{
  "version": 1,
  "files": {
    "client.ts": "client.jinja",
    "routing/routes.ts": "routes.jinja"
  },
  "options": {
    "className": "WidgetClient"
  },
  "typescript": {
    "interfacePrefix": "I"
  },
  "modelFiles": [
    { "kind": "interface", "directory": "interfaces", "template": "interfaces/model.jinja" },
    { "kind": "type", "directory": "types", "template": "types/model.jinja" }
  ]
}
```

The `files` keys are relative paths below `--out`. Their values are template paths relative to the manifest. You can use includes and macros inside a profile. Templates can only load files within the profile directory. Options are arbitrary JSON data supplied by the project.

`typescript.interfacePrefix` changes generated interface names and their references before rendering. Type aliases keep their names. With `modelFiles`, choose a template and output directory for object interfaces or type aliases. Each matched model is written to `<directory>/<name>.ts` and is available as `model` in that template. Regular `files` entries can still emit any other files.

Use `{{ operation.path | ts_string }}` to quote specification text as a TypeScript string literal. Use `{{ options.className | ts_identifier }}` when an option must be a TypeScript identifier. Call `fail(message)` for invalid profile-specific options. Undefined variables fail rendering and report the template location. All templates render before writes start.

## Template context version 1

Run `quivra inspect <spec> --profile <profile>` to see the context for your own API.

| Field | Value |
| --- | --- |
| `api.title` | Title from the input document |
| `models` | Model `name`, object `fields`, and nullable `type_alias` for models represented by TypeScript type expressions |
| `operations` | Normalized operation ID, uppercase HTTP method, wire path and the fields described below |
| `imports` | Models referenced by operation signatures. Each entry has a `name` and `is_type_alias`. Models and operations also expose their own imports. |
| `event_type` | Generated name for the SSE event interface |
| `uses_sse` | Whether any operation declares a successful event-stream response |
| `options` | Data from the profile manifest |

A field contains its wire `name`, TypeScript `type`, and `optional`. Fields remain in the wire casing. Component and operation identifiers are normalized for TypeScript. If two original names normalize to the same identifier, Quivra reports the collision.

An operation contains:

- `id`, `method`, `path`, and optional `summary`.
- `path_parameters` and `query_parameters` with the wire names, type expressions and optionality.
- `body_type` and `body_optional`. A null body type means there is no request body.
- `response_type`, the TypeScript union of the declared successful results.
- `responses`, which preserves each declared success status as `status` (null for `2XX`), `kind` (`json`, `void`, or `sse`), TypeScript `type`, and nullable `media_type`. The current projection accepts one success media type per status.
- `accept`, the list of declared success media types as an HTTP header value, or null.
- `extensions`, a JSON object with the operation’s `x-*` values.
- `security`, a list of alternative groups. Every credential in a selected group is required. An empty group allows anonymous access. Each credential has a scheme `name`, `kind` (`bearer` or `apiKey`), `location` (`header` or `query`), and `wire_name`.

The sample transport owns decoding and authentication I/O. It receives the resolved method, path and headers and returns a response adapter with a status and body readers. The Fetch profile does that work directly. Event data is exposed as text; a project can decode it in its own transport or template.

## References and conformance

Relative references resolve against the document that declares them. By default the root is the entry spec's parent directory. Use `--reference-root` to include sibling schema folders under a shared root. References that leave that root or require a network request fail.

This context describes the TypeScript projection, rather than a full OpenAPI or JSON Schema validator. The bundled clients use simple scalar path and form-style query serialization, JSON request bodies, and one JSON, empty or SSE response shape per success status. The context exposes success schemas. The starter clients raise an HTTP error for unsuccessful or undeclared statuses. Specialized encodings and typed error bodies need additional projections.

The OpenAPI 3.1 subset accepts one schema type with an optional null alternative. Boolean schemas, dialects outside the OpenAPI base and JSON Schema 2020-12, identifiers and anchors, and validation keywords alongside schema references are unsupported. Read/write model projections are shared.
