mod operations;
mod runtime_contracts;
mod schemas;

use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::openapi::Api;
use operations::ClientOperation;
pub(crate) use schemas::Model;
use schemas::{ModelImport, SchemaTypes};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub(crate) struct ProjectionOptions {
    pub interface_prefix: String,
    pub type_alias_prefix: String,
    pub ignore_unused_models: bool,
    pub exclude_deprecated_operations: bool,
    pub preserve_nullable_annotations: bool,
    pub broad_http: bool,
    pub enum_objects: bool,
    pub object_index_interfaces: bool,
    pub strip_service_tag_suffix: String,
    pub runtime_contracts: bool,
}

#[derive(Serialize)]
pub struct ContextData<'a> {
    api: ApiInfo<'a>,
    models: Vec<Model>,
    imports: BTreeSet<ModelImport>,
    event_type: String,
    operations: Vec<Rc<ClientOperation<'a>>>,
    services: Vec<Service<'a>>,
    uses_sse: bool,
    options: &'a BTreeMap<String, Value>,
    runtime_contracts: Option<runtime_contracts::RuntimeContracts>,
}

#[derive(Serialize)]
pub(crate) struct Service<'a> {
    name: String,
    type_name: String,
    description: Option<String>,
    operations: Vec<Rc<ClientOperation<'a>>>,
    imports: BTreeSet<ModelImport>,
}

impl Service<'_> {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn type_name(&self) -> &str {
        &self.type_name
    }
}

#[derive(Serialize)]
struct ApiInfo<'a> {
    title: &'a str,
}

impl ContextData<'_> {
    pub(crate) fn models(&self) -> &[Model] {
        &self.models
    }

    pub(crate) fn services(&self) -> &[Service<'_>] {
        &self.services
    }
}

pub fn context<'a>(
    api: &'a Api,
    options: &'a BTreeMap<String, Value>,
    projection: &ProjectionOptions,
) -> Result<ContextData<'a>> {
    let interface_prefix = projection.interface_prefix.as_str();
    let alias_prefix = projection.type_alias_prefix.as_str();
    ensure!(
        interface_prefix.is_empty() || valid_identifier(interface_prefix),
        "invalid TypeScript interface prefix {interface_prefix:?}"
    );
    ensure!(
        alias_prefix.is_empty() || valid_identifier(alias_prefix),
        "invalid TypeScript type alias prefix {alias_prefix:?}"
    );
    let event_type = interface_name(interface_prefix, "QuivraEvent");
    let types = SchemaTypes::new(
        &api.components.schemas,
        interface_prefix,
        alias_prefix,
        &event_type,
        projection.preserve_nullable_annotations,
        projection.enum_objects,
        projection.object_index_interfaces,
    )?;
    let mut models = types.models()?;
    let runtime_contracts = if projection.runtime_contracts {
        let names: BTreeMap<_, _> = models
            .iter()
            .map(|model| (model.raw_name(), model.name()))
            .collect();
        Some(runtime_contracts::project(
            &api.original_schemas,
            api.openapi30,
            |name| names.get(name).map(|name| (*name).to_owned()),
        )?)
    } else {
        None
    };
    let operations: Vec<_> = operations::build(
        api,
        &types,
        &event_type,
        projection.exclude_deprecated_operations,
        projection.broad_http,
    )?
    .into_iter()
    .map(Rc::new)
    .collect();
    if projection.ignore_unused_models {
        schemas::retain_used_models(
            &mut models,
            operations.iter().flat_map(|op| op.model_references()),
        );
    }
    let imports = operations
        .iter()
        .flat_map(|operation| operation.imports().iter().cloned())
        .collect();
    let uses_sse = operations.iter().any(|operation| operation.uses_sse());
    let mut by_tag = BTreeMap::<&str, Vec<Rc<ClientOperation<'a>>>>::new();
    for operation in &operations {
        if operation.tags.is_empty() {
            by_tag.entry("Api").or_default().push(operation.clone());
        } else {
            let tags: BTreeSet<_> = operation.tags.iter().collect();
            for tag in tags {
                by_tag.entry(tag).or_default().push(operation.clone());
            }
        }
    }
    let services = by_tag
        .into_iter()
        .map(|(tag, operations)| {
            let imports = operations
                .iter()
                .flat_map(|operation| operation.model_references().cloned())
                .collect();
            Service {
                name: tag.into(),
                type_name: type_name(
                    tag.strip_suffix(&projection.strip_service_tag_suffix)
                        .unwrap_or(tag),
                ),
                description: api.tags.get(tag).cloned().flatten(),
                operations,
                imports,
            }
        })
        .collect();
    Ok(ContextData {
        api: ApiInfo {
            title: &api.info.title,
        },
        models,
        imports,
        event_type,
        operations,
        services,
        uses_sse,
        options,
        runtime_contracts,
    })
}

fn names<'a>(
    raw_names: impl IntoIterator<Item = &'a String>,
    kind: &str,
) -> Result<BTreeMap<&'a str, String>> {
    let mut allocated = BTreeSet::new();
    let mut names = BTreeMap::new();
    for raw in raw_names {
        let normalized = identifier(raw);
        ensure!(
            allocated.insert(normalized.clone()),
            "{kind} name collision after TypeScript normalization: {raw:?} -> {normalized}"
        );
        names.insert(raw.as_str(), normalized);
    }
    Ok(names)
}

fn type_name(name: &str) -> String {
    let mut result = String::new();
    for word in name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
    {
        result.push(char::from(word.as_bytes()[0]).to_ascii_uppercase());
        result.push_str(&word[1..]);
    }
    identifier(&result)
}

fn interface_name(prefix: &str, name: &str) -> String {
    let already_prefixed = name
        .strip_prefix(prefix)
        .and_then(|suffix| suffix.as_bytes().first())
        .is_some_and(u8::is_ascii_uppercase);
    if prefix.is_empty() || already_prefixed {
        name.into()
    } else {
        format!("{prefix}{name}")
    }
}

pub(super) fn identifier(name: &str) -> String {
    let mut result = String::new();
    for character in name.chars() {
        result.push(if identifier_character(character) {
            character
        } else {
            '_'
        });
    }
    if !valid_identifier(&result) || result.starts_with("$quivra") || result == "QuivraEvent" {
        result.insert(0, '_');
    }
    result
}

fn identifier_start(character: char) -> bool {
    character.is_ascii_alphabetic() || matches!(character, '_' | '$')
}

fn identifier_character(character: char) -> bool {
    identifier_start(character) || character.is_ascii_digit()
}

pub(crate) fn valid_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    characters.next().is_some_and(identifier_start)
        && characters.all(identifier_character)
        && !matches!(
            name,
            "abstract"
                | "any"
                | "as"
                | "asserts"
                | "async"
                | "await"
                | "bigint"
                | "boolean"
                | "break"
                | "case"
                | "catch"
                | "class"
                | "const"
                | "constructor"
                | "continue"
                | "debugger"
                | "declare"
                | "default"
                | "delete"
                | "do"
                | "else"
                | "enum"
                | "eval"
                | "export"
                | "extends"
                | "false"
                | "finally"
                | "for"
                | "from"
                | "function"
                | "get"
                | "global"
                | "if"
                | "implements"
                | "import"
                | "in"
                | "infer"
                | "instanceof"
                | "interface"
                | "is"
                | "keyof"
                | "let"
                | "module"
                | "namespace"
                | "never"
                | "new"
                | "null"
                | "number"
                | "object"
                | "of"
                | "override"
                | "package"
                | "private"
                | "protected"
                | "public"
                | "readonly"
                | "require"
                | "return"
                | "satisfies"
                | "set"
                | "static"
                | "string"
                | "super"
                | "switch"
                | "symbol"
                | "this"
                | "throw"
                | "true"
                | "try"
                | "type"
                | "typeof"
                | "undefined"
                | "unique"
                | "unknown"
                | "using"
                | "var"
                | "void"
                | "while"
                | "with"
                | "yield"
                | "arguments"
                | "globalThis"
                | "__proto__"
                | "AsyncIterable"
        )
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::rc::Rc;

    use serde_json::json;

    use super::*;

    #[test]
    fn groups_tags_and_preserves_wire_metadata_in_the_projected_context() {
        let document = json!({
            "openapi": "3.0.3",
            "info": {"title": "Articles"},
            "tags": [{"name": "event-stream", "description": "Article events"}],
            "paths": {
                "/articles": {"get": {
                    "operationId": "stream-articles",
                    "tags": ["event-stream", "admin", "admin"],
                    "description": "Read article events",
                    "parameters": [
                        {"name": "author", "in": "query", "schema": {"type": "string"}},
                        {"name": "after", "in": "query", "deprecated": true, "schema": {"type": "string"}}
                    ],
                    "responses": {
                        "200": {"description": "Events", "content": {"text/event-stream": {
                            "schema": {"$ref": "#/components/schemas/Envelope"}
                        }}},
                        "401": {"description": "Unauthorized"}
                    }
                }},
                "/old": {"get": {
                    "operationId": "old",
                    "deprecated": true,
                    "responses": {"200": {"content": {"application/json": {
                        "schema": {"$ref": "#/components/schemas/Old"}
                    }}}}
                }}
            },
            "components": {"schemas": {
                "Envelope": {"type": "object", "x-archipel-envelope": {"version": 2, "dataProperty": "data"}, "properties": {
                    "data": {"$ref": "#/components/schemas/__schema0"}
                }},
                "__schema0": {"anyOf": [{"type": "string"}, {"type": "integer"}]},
                "Old": {"type": "object"}
            }}
        });
        let tmp = tempfile::tempdir().unwrap();
        let spec = tmp.path().join("api.json");
        fs::write(&spec, serde_json::to_vec(&document).unwrap()).unwrap();
        let api = crate::openapi::load(&spec, None).unwrap();
        let options = BTreeMap::new();
        let names = ProjectionOptions {
            interface_prefix: "I".into(),
            type_alias_prefix: "I".into(),
            ..ProjectionOptions::default()
        };

        let context_data = context(&api, &options, &names).unwrap();
        assert!(Rc::ptr_eq(
            &context_data
                .services
                .iter()
                .find(|service| service.name() == "admin")
                .unwrap()
                .operations[0],
            &context_data
                .services
                .iter()
                .find(|service| service.name() == "event-stream")
                .unwrap()
                .operations[0]
        ));
        let complete = serde_json::to_value(context_data).unwrap();
        let operation = &complete["operations"][0];
        assert_eq!(operation["raw_id"], "stream-articles");
        assert_eq!(operation["parameters"][0]["name"], "author");
        assert_eq!(operation["parameters"][1]["deprecated"], true);
        assert_eq!(operation["responses"][0]["wire_type"], "IEnvelope");
        assert_eq!(operation["responses"][0]["envelope_property"], "data");
        assert_eq!(operation["all_responses"][1]["status"], "401");
        let service = complete["services"]
            .as_array()
            .unwrap()
            .iter()
            .find(|service| service["name"] == "event-stream")
            .unwrap();
        assert_eq!(service["type_name"], "EventStream");
        assert_eq!(service["description"], "Article events");
        assert_eq!(service["imports"][0]["name"], "IEnvelope");

        let active = ProjectionOptions {
            ignore_unused_models: true,
            exclude_deprecated_operations: true,
            ..names
        };
        let active = serde_json::to_value(context(&api, &options, &active).unwrap()).unwrap();
        let model_names: Vec<_> = active["models"]
            .as_array()
            .unwrap()
            .iter()
            .map(|model| model["name"].as_str().unwrap())
            .collect();
        assert_eq!(model_names, ["IEnvelope", "ISchema0"]);
        let active_operations = active["operations"].as_array().unwrap();
        assert_eq!(active_operations.len(), 1);
        assert_eq!(
            active_operations[0]["parameters"].as_array().unwrap().len(),
            1
        );
    }
}
