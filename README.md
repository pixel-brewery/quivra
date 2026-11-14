# Quivra

Generate TypeScript clients from OpenAPI with project-owned MiniJinja templates. The Rust CLI reads the API and prepares the template data. Your profile decides what code is generated and where it goes.

This project is maintained by [Pixel Brewery](https://github.com/pixel-brewery).

## Try two clients from one spec

Install [Rust with rustup](https://rustup.rs/) and Node.js 24, then run these commands from the repository root:

```sh
cargo build --locked
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/fetch --out examples/generated/fetch
target/debug/quivra generate examples/openapi.yaml --profile examples/profiles/transport --out examples/generated/transport
node examples/smoke.mjs
```

| Profile | Output from the same [Widget API](examples/openapi.yaml) |
| --- | --- |
| [Fetch](examples/profiles/fetch) | [Standalone functions and mutable models](examples/generated/fetch/client.ts). The client sends HTTP requests with Fetch and reads server-sent events. |
| [Transport](examples/profiles/transport) | [One client class with an injected transport](examples/generated/transport/client.ts), with [individual readonly interfaces](examples/generated/transport/interfaces), [type aliases](examples/generated/transport/types), and a [route table](examples/generated/transport/routes.ts). |

The generated examples are committed so you can compare them without installing anything.

## Customize your client

```sh
target/debug/quivra init --preset fetch --out profiles/my-api
target/debug/quivra inspect examples/openapi.yaml --profile profiles/my-api
target/debug/quivra generate examples/openapi.yaml --profile profiles/my-api --out src/api
target/debug/quivra generate examples/openapi.yaml --profile profiles/my-api --out src/api --check
```

Edit the copied `.jinja` files to change the code. Edit `profile.json` to control which templates produce which files and to supply project options. The CLI uses the same template engine for starter profiles and your own. See the [profile guide](docs/profiles.md).

## Supported API shapes

Quivra reads local YAML or JSON documents using OpenAPI 3.0 or 3.1. It supports local relative references, scalar path and query parameters, JSON requests, status-specific JSON and empty responses, and server-sent events. The starter profiles support bearer tokens and header or query API keys.

Schema generation covers objects, arrays, maps, references, scalar literals, nullable types and structural projections of `allOf`, `anyOf` and `oneOf`. TypeScript declarations do not perform runtime schema validation or enforce `oneOf` exclusivity. Unsupported shapes include remote references, multipart bodies, binary responses, cookie and OAuth security schemes, and custom parameter serialization. See the [profile guide](docs/profiles.md) for the supported context and its limits.

## Install and develop

- [Distribution](docs/distribution.md) covers GitHub release binaries, npm installation and the typed Node API.
- [CI, releases and dependency updates](docs/ci-cd.md) covers checks, Dependabot and release preparation.
- [Architecture and contributor checks](docs/architecture.md) explain where to make changes and how to verify them.
