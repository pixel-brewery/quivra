# Quivra

Quivra generates TypeScript clients from OpenAPI documents using project-owned MiniJinja profiles. The Rust CLI reads the API and prepares the template data. The profile owns the emitted code and the file layout.

## Run the demo

Use a recent stable Rust toolchain and Node.js 22.18 or newer.

```sh
cargo build --locked
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/fetch --out examples/generated/fetch
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/transport --out examples/generated/transport
node examples/smoke.mjs
```

Both commands read [the same Widget API](examples/openapi.yaml). The generated output is checked in so you can compare it immediately.

| Profile | Generated API |
| --- | --- |
| [Fetch functions](examples/profiles/fetch) | [client.ts](examples/generated/fetch/client.ts) exports functions such as `listWidgets({ baseUrl }, { query: { search: "red" } })`. It handles HTTP with Fetch and emits mutable model fields. |
| [Injected transport](examples/profiles/transport) | [client.ts](examples/generated/transport/client.ts) exports `WidgetClient` and readonly models. Call `new WidgetClient(transport).listWidgets({ query: { search: "red" } })`. The profile also emits [routes.ts](examples/generated/transport/routes.ts). |

The smoke test invokes both clients with simulated transports and checks path encoding, optional scalar query values, JSON bodies, HTTP errors and empty responses. To type-check the generated files:

```sh
npx --yes --package typescript@6.0.3 tsc --strict --noEmit --target ES2022 --module ESNext --lib ES2022,DOM examples/generated/fetch/client.ts examples/generated/transport/client.ts examples/generated/transport/routes.ts
```

## Write a profile

Copy an example profile to your project. Edit its templates to change the public client API, wire it to your own transport, change the model declarations, or emit additional files. Pass the profile directory or the path to its `profile.json` to Quivra.

```json
{
  "version": 1,
  "files": {
    "client.ts": "client.jinja",
    "routing/routes.ts": "routes.jinja"
  },
  "options": {
    "className": "WidgetClient"
  }
}
```

The `files` map pairs an output path relative to `--out` with a template path relative to the profile. Templates can use MiniJinja includes and macros. Options are passed to templates as data. A template that places an option in source code, such as the example's `className`, expects the project to provide a valid value for that position.

```sh
target/debug/quivra inspect examples/openapi.yaml --profile examples/profiles/transport
```

`inspect` prints exactly the data available to templates in profile version 1:

- `api.title` is the title from the input specification.
- `models` contains each component's `name` and `fields` with `name`, `type` and `optional`.
- `operations` contains `id`, `method`, `path`, `path_parameters`, `query_parameters`, `body_type`, `response_type` and `summary`. `body_type` and `summary` can be null. `response_type` is `void` for a bodyless success response.
- `options` contains the profile's configuration.

Use `{{ operation.path | ts_string }}` to quote a specification value as a TypeScript string literal. Undefined template variables cause an error before output files are written. Generation replaces the paths declared in the profile and leaves other files in the output directory in place. Use a dedicated output directory for each profile.

## Prototype scope

The supported input is a local OpenAPI 3.0.x YAML or JSON document with object components, local component schema references, scalar types and enums, arrays, inline objects, required JSON request bodies and one JSON or bodyless success response per operation. Path and query parameters use the default scalar serialization. Operation IDs and component names must be TypeScript identifiers within the generator's supported subset.

OpenAPI 3.1, schema composition, external references, authentication, streaming, generated runtime validation and executable profile hooks are outside the prototype's scope. The demo uses a self-contained specification so both profiles can be run without Mosaik or a live API.
