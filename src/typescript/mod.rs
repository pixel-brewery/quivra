mod operations;
mod schemas;

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Result, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::openapi::Api;
use operations::ClientOperation;
pub(crate) use schemas::Model;
use schemas::{ModelImport, SchemaTypes};

#[derive(Serialize)]
pub struct ContextData<'a> {
    api: ApiInfo<'a>,
    models: Vec<Model>,
    imports: BTreeSet<ModelImport>,
    event_type: String,
    operations: Vec<ClientOperation<'a>>,
    uses_sse: bool,
    options: &'a BTreeMap<String, Value>,
}

#[derive(Serialize)]
struct ApiInfo<'a> {
    title: &'a str,
}

impl ContextData<'_> {
    pub(crate) fn models(&self) -> &[Model] {
        &self.models
    }
}

pub fn context<'a>(
    api: &'a Api,
    options: &'a BTreeMap<String, Value>,
    interface_prefix: &str,
) -> Result<ContextData<'a>> {
    ensure!(
        interface_prefix.is_empty() || valid_identifier(interface_prefix),
        "invalid TypeScript interface prefix {interface_prefix:?}"
    );
    let event_type = interface_name(interface_prefix, "QuivraEvent");
    let types = SchemaTypes::new(&api.components.schemas, interface_prefix, &event_type)?;
    let models = types.models()?;
    let operations = operations::build(api, &types, &event_type)?;
    let imports = operations
        .iter()
        .flat_map(|operation| operation.imports().iter().cloned())
        .collect();
    let uses_sse = operations.iter().any(|operation| operation.uses_sse());
    Ok(ContextData {
        api: ApiInfo {
            title: &api.info.title,
        },
        models,
        imports,
        event_type,
        operations,
        uses_sse,
        options,
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
