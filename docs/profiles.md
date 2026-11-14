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

`typescript.interfacePrefix` prefixes interface names and references. `typescript.typeAliasPrefix` applies a prefix to PascalCase type alias names and references. With `modelFiles`, choose a template and output directory for object interfaces or type aliases. Each matched model is written to `<directory>/<name>.ts` and is available as `model` in that template.

Set `typescript.ignoreUnusedModels` to emit the models referenced directly or transitively by operations. `typescript.excludeDeprecatedOperations` excludes deprecated operations and deprecated query parameters. `typescript.preserveNullableAnnotations` keeps an explicit OpenAPI 3.0 `nullable` annotation on a reference, composed or enum schema, including when producers omit `null` in enum values.

`typescript.enumObjects` exposes eligible named enums with their ordered `enum_values` and enables an `enum` rule in `modelFiles`. `typescript.objectIndexInterfaces` allows a plain object with additional properties to remain an interface and exposes its `index_signature_type`. `typescript.stripServiceTagSuffix` removes an exact suffix from the tag used to form the generated service name.

`typescript.runtimeContracts` projects the validation schemas reachable from components marked `x-assistant-action: true`. The template receives `runtime_contracts.definitions`, the type-to-reference map `runtime_contracts.schemas`, and `runtime_contracts.actions`. Quivra checks the declared action payload fingerprint against the generated schema before rendering.

Use `serviceFiles` to render one file per OpenAPI tag. For example, `"serviceFiles": [{ "directory": "services", "template": "service.jinja", "suffix": "ApiClient" }]` writes `services/WidgetsApiClient.ts` for the `widgets` tag. The template receives that entry as `service`, with a tag `name`, TypeScript `type_name`, optional `description`, and its `operations` and model `imports`.

Use `{{ operation.path | ts_string }}` to quote specification text as a TypeScript string literal. Use `{{ options.className | ts_identifier }}` when an option must be a TypeScript identifier. Call `fail(message)` for invalid profile-specific options. Undefined variables fail rendering and report the template location. All templates render before writes start.

## Template context version 1

Run `quivra inspect <spec> --profile <profile>` to see the context for your own API.

| Field | Value |
| --- | --- |
| `api.title` | Title from the input document |
| `models` | Model `name`, object `fields`, and nullable `type_alias` for models represented by TypeScript type expressions |
| `operations` | Normalized operation ID, uppercase HTTP method, wire path and the fields described below |
| `services` | Operations grouped by OpenAPI tag. Untagged operations appear under `Api`. |
| `imports` | Models referenced by operation signatures. Each entry has a `name` and `is_type_alias`. Models and operations also expose their own imports. |
| `event_type` | Generated name for the SSE event interface |
| `uses_sse` | Whether any operation declares a successful event-stream response |
| `options` | Data from the profile manifest |

A field contains its wire `name`, TypeScript `type`, and `optional`. Fields remain in the wire casing. Component and operation identifiers are normalized for TypeScript. If two original names normalize to the same identifier, Quivra reports the collision.

An operation contains:

- `id`, `method`, `path`, and optional `summary`.
- `raw_id`, `description`, `tags`, `deprecated`, and source-ordered `parameters` with the wire `location`, a TypeScript `variable`, and `style`, `explode`, and `allow_reserved` serialization metadata.
- `path_parameters` and `query_parameters` with the wire names, type expressions and optionality.
- `body_type` and `body_optional`. A null body type means there is no request body.
- `response_type`, the TypeScript union of the declared successful results.
- `responses`, which preserves declared success statuses as `status` (null for `2XX`), `kind`, TypeScript `type`, and nullable `media_type`. The default projection accepts one JSON or SSE media type per status, as well as empty responses.
- `all_responses`, with the status, description, media types, and `x-*` extensions of each response, including errors.
- `accept`, the list of declared success media types as an HTTP header value, or null.
- `extensions`, a JSON object with the operation’s `x-*` values.
- `security`, a list of alternative groups. Every credential in a selected group is required. An empty group allows anonymous access. Each credential has a scheme `name`, `kind` (`bearer` or `apiKey`), `location` (`header` or `query`), and `wire_name`.

Set `typescript.broadHttp` for a profile that implements additional HTTP serialization and decoding itself. This makes header parameters and non-scalar parameter schemas available and projects additional request and success media types, including multipart, text and binary content. The projected response kinds include `text` and `blob`. Values declared as `type: string, format: binary` project to `Blob` in media schemas.

With this option, `variants` pairs each request media type with each media type of the first successful status. The template receives the method `name`, the nullable `request_body` with `media_type` and `type`, and the nullable `response` with its media, schema and status information. `success_status` is the first numeric success status, with `200` as the fallback. `path_expression` is a TypeScript template literal body that expects `params` and encodes each path parameter as a URL segment.

## Generating multiple documents

`quivra generate-batch batch.json --profile <profile> --out <directory>` renders each document into the same output plan. Each array entry specifies a TypeScript `namespace`, an output `directory`, and a `spec` path resolved relative to `batch.json`. Use `--check` to compare that entire plan with the existing output.

```json
[
  { "namespace": "catalog", "directory": "catalog", "spec": "catalog.yaml" },
  { "namespace": "apiKeys", "directory": "api-keys", "spec": "api-keys.yaml" }
]
```

The profile’s optional `batchFiles` map uses the same format as `files`. It renders files at the batch root, such as an index exporting all namespaces. These templates receive `documents`, with the `namespace` and `directory` of each document in manifest order, and the profile `options`.

The sample transport owns decoding and authentication I/O. It receives the resolved method, path and headers and returns a response adapter with a status and body readers. The Fetch profile does that work directly. Event data is exposed as text; a project can decode it in its own transport or template.

## References and conformance

Relative references resolve against the document that declares them. By default the root is the entry spec's parent directory. Use `--reference-root` to include sibling schema folders under a shared root. References that leave that root or require a network request fail.

This context describes the TypeScript projection, rather than a full OpenAPI or JSON Schema validator. The bundled clients use simple scalar path and form-style query serialization, JSON request bodies, and one JSON, empty or SSE response shape per success status. The context exposes success schemas. The starter clients raise an HTTP error for unsuccessful or undeclared statuses. Specialized encodings and typed error bodies need additional projections.

The OpenAPI 3.1 subset accepts one schema type with an optional null alternative. Boolean schemas, dialects outside the OpenAPI base and JSON Schema 2020-12, identifiers and anchors, and validation keywords alongside schema references are unsupported. Read/write model projections are shared.
