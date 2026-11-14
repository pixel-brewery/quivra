use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

use super::{ApiKeyLocation, SecurityScheme, load};

const API: &str = r##"
openapi: 3.1.1
info:
  title: References demo
paths:
  /widgets/{id}:
    $ref: "./parts/endpoint.yaml"
components:
  securitySchemes:
    bearer:
      type: http
      scheme: Bearer
    queryKey:
      type: apiKey
      name: access-token
      in: query
  schemas:
    Widget:
      $ref: "./parts/models%20and%20types.json#/$defs/Widget"
security:
  - bearer: []
    queryKey: []
  - {}
"##;

const ENDPOINT: &str = r##"
parameters:
  - $ref: "./parameter.yaml"
get:
  operationId: getWidget
  responses:
    "200":
      $ref: "./response.yaml"
    "204":
      description: No widget
    "2XX":
      description: Event stream
      content:
        text/event-stream: {}
"##;

const MODELS: &str = r##"
{
  "$defs": {
    "Widget": {
      "type": "object",
      "properties": {
        "label": {"type": ["string", "null"]},
        "next": {"$ref": "#/$defs/Widget"},
        "annotation": {"type":"object","examples":[{"$ref":"https://example.test/just-data"}]}
      }
    }
  }
}
"##;

#[test]
fn resolves_relative_chains_and_preserves_a_recursive_schema() {
    let directory = TempDir::new().unwrap();
    let entry = write(directory.path(), "api.yaml", API);
    write(directory.path(), "parts/endpoint.yaml", ENDPOINT);
    write(
        directory.path(),
        "parts/parameter.yaml",
        "name: id\nin: path\nrequired: true\nschema: {type: string}",
    );
    write(
        directory.path(),
        "parts/response.yaml",
        r##"
description: Found
content:
  application/json:
    schema:
      $ref: "./models%20and%20types.json#/$defs/Widget"
"##,
    );
    write(directory.path(), "parts/models and types.json", MODELS);

    let api = load(&entry, None).unwrap();
    let endpoints = api.endpoints().unwrap();
    let [endpoint] = endpoints.as_slice() else {
        panic!("expected a single operation");
    };
    assert_eq!(endpoint.path, "/widgets/{id}");
    assert_eq!(endpoint.parameters[0].name, "id");
    assert_eq!(endpoint.security.len(), 2);
    assert_eq!(endpoint.security[0].len(), 2);
    assert!(endpoint.security[1].is_empty());
    assert!(matches!(
        api.components.security_schemes["bearer"],
        SecurityScheme::Bearer
    ));
    assert!(matches!(
        api.components.security_schemes["queryKey"],
        SecurityScheme::ApiKey {
            location: ApiKeyLocation::Query,
            ..
        }
    ));

    let successes = endpoint.operation.success_responses();
    assert_eq!(
        successes
            .iter()
            .map(|(status, _)| *status)
            .collect::<Vec<_>>(),
        ["200", "204", "2XX"]
    );
    let reference = api.components.schemas["Widget"]
        .reference
        .as_deref()
        .unwrap();
    let name = reference.strip_prefix("#/components/schemas/").unwrap();
    let widget = &api.components.schemas[name];
    assert_eq!(
        widget.properties["next"].reference.as_deref(),
        Some(reference)
    );
    assert!(widget.properties["label"].nullable);
    assert_eq!(widget.properties["label"].kind.as_deref(), Some("string"));
    assert_eq!(
        successes[0].1.content[0]
            .1
            .schema
            .as_ref()
            .unwrap()
            .reference
            .as_deref(),
        Some(reference)
    );
    assert!(successes[1].1.content.is_empty());
    assert!(successes[2].1.content[0].1.schema.is_none());
}

#[test]
fn checks_reference_root_after_resolving_paths() {
    let directory = TempDir::new().unwrap();
    let entry = write(
        directory.path(),
        "api/main.yaml",
        &API.replace("./parts/endpoint.yaml", "../endpoint.yaml"),
    );
    write(
        directory.path(),
        "endpoint.yaml",
        "get: {operationId: getWidget, responses: {\"204\": {description: Empty}}}",
    );

    let error = load(&entry, None)
        .err()
        .expect("reference escaped the root");
    assert!(format!("{error:#}").contains("reference escapes the reference root"));

    let entry = write(
        directory.path(),
        "api/main.yaml",
        r##"
openapi: 3.0.3
info: {title: Root test}
paths:
  /widgets:
    $ref: "../endpoint.yaml"
"##,
    );
    let api = load(&entry, Some(directory.path())).unwrap();
    assert_eq!(
        api.endpoints().unwrap()[0].operation.operation_id,
        "getWidget"
    );
}

#[test]
fn detects_alias_cycles_and_blocks_remote_references() {
    let directory = TempDir::new().unwrap();
    let entry = write(
        directory.path(),
        "api.yaml",
        r##"
openapi: 3.0.3
info: {title: Cycles}
components:
  schemas:
    A: {$ref: "#/components/schemas/B"}
    B: {$ref: "#/components/schemas/A"}
paths:
  /example:
    get:
      operationId: getExample
      responses: {"204": {description: Empty}}
"##,
    );
    let error = load(&entry, None)
        .err()
        .expect("alias-only cycle was accepted");
    assert!(format!("{error:#}").contains("schema reference cycle with no concrete shape"));

    let entry = write(
        directory.path(),
        "api.yaml",
        &API.replace(
            "./parts/endpoint.yaml",
            "https://example.test/endpoint.yaml",
        ),
    );
    let error = load(&entry, None)
        .err()
        .expect("remote reference was accepted");
    assert!(format!("{error:#}").contains("only relative local references are supported"));
}

fn write(directory: &Path, name: &str, contents: &str) -> PathBuf {
    let path = directory.join(name);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, contents).unwrap();
    path
}
