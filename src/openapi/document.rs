use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Map, Value};

use super::references::{Documents, Location, escape_token};
use super::{Api, Components, is_method};

const MAX_REFERENCE_CHAIN: usize = 128;
const MAX_SCHEMA_DEPTH: usize = 96;
const MAX_SCHEMAS: usize = 4096;

const SCHEMA_REF_PREFIX: &str = "#/components/schemas/";

#[derive(Clone, Copy)]
enum Dialect {
    OpenApi30,
    OpenApi31,
}

pub(super) fn load(path: &Path, reference_root: Option<&Path>) -> Result<Api> {
    let (mut documents, entry) = Documents::new(path, reference_root)?;
    let mut document = documents.get(&entry)?;
    let version = document
        .get("openapi")
        .and_then(Value::as_str)
        .context("missing OpenAPI version")?;
    let dialect = Dialect::parse(version)?;
    if let Some(dialect_url) = document.get("jsonSchemaDialect") {
        ensure!(
            matches!(dialect, Dialect::OpenApi31) && supported_dialect(dialect_url),
            "unsupported jsonSchemaDialect {dialect_url}"
        );
    }

    let info = serde_json::from_value(take(object(&mut document)?, "info")?)
        .context("invalid API info")?;
    let security = object(&mut document)?
        .remove("security")
        .map(serde_json::from_value)
        .transpose()
        .context("invalid API security requirements")?
        .unwrap_or_default();
    let component_keys = match document.pointer("/components/schemas") {
        Some(Value::Object(schemas)) => schemas.keys().cloned().collect::<Vec<_>>(),
        Some(_) => bail!("components.schemas must be an object"),
        None => Vec::new(),
    };
    ensure!(
        component_keys.len() <= MAX_SCHEMAS,
        "too many component schemas"
    );
    let mut normalizer = Normalizer::new(documents, dialect, &entry, component_keys);
    let mut components = match object(&mut document)?.remove("components") {
        None => Components::default(),
        Some(mut value) => {
            let components = object(&mut value).context("invalid components")?;
            // Original schemas are normalized from their registered source locations.
            components.remove("schemas");
            if let Some(schemes) = components.get_mut("securitySchemes") {
                normalizer.security_schemes(
                    schemes,
                    &entry.child("components").child("securitySchemes"),
                )?;
            }
            serde_json::from_value(value).context("invalid components")?
        }
    };

    let mut paths = take(object(&mut document)?, "paths").context("the API must declare paths")?;
    let paths_map = object(&mut paths).context("paths must be an object")?;
    paths_map.retain(|path, _| !path.starts_with("x-"));
    for (name, path) in paths_map {
        normalizer
            .path(path, &entry.child("paths").child(name))
            .with_context(|| format!("path {name:?}"))?;
    }
    let paths = serde_json::from_value(paths).context("invalid normalized paths")?;
    components.schemas = normalizer.schemas()?;
    Ok(Api {
        info,
        components,
        paths,
        security,
    })
}

impl Dialect {
    fn parse(version: &str) -> Result<Self> {
        if let Some((minor, patch)) = version
            .strip_prefix("3.")
            .and_then(|value| value.split_once('.'))
            && !patch.is_empty()
            && patch.bytes().all(|byte| byte.is_ascii_digit())
        {
            match minor {
                "0" => return Ok(Self::OpenApi30),
                "1" => return Ok(Self::OpenApi31),
                _ => {}
            }
        }
        bail!("expected OpenAPI 3.0.x or 3.1.x, got {version:?}")
    }
}

struct Normalizer {
    documents: Documents,
    dialect: Dialect,
    schema_names: BTreeMap<Location, String>,
    pending: VecDeque<(String, Location)>,
    used_names: BTreeSet<String>,
}

impl Normalizer {
    fn new(documents: Documents, dialect: Dialect, entry: &Location, names: Vec<String>) -> Self {
        let pending = names
            .into_iter()
            .map(|name| {
                let location = entry.child("components").child("schemas").child(&name);
                (name, location)
            })
            .collect::<VecDeque<_>>();
        let schema_names = pending
            .iter()
            .map(|(name, location)| (location.clone(), name.clone()))
            .collect();
        let used_names = pending.iter().map(|(name, _)| name.clone()).collect();
        Self {
            documents,
            dialect,
            schema_names,
            pending,
            used_names,
        }
    }

    fn path(&mut self, value: &mut Value, source: &Location) -> Result<()> {
        let source = self.resolve_object(value, source)?;
        let path = object(value)?;
        if let Some(parameters) = path.get_mut("parameters") {
            self.parameters(parameters, &source.child("parameters"))?;
        }
        for (method, operation) in path {
            if is_method(method) {
                self.operation(operation, &source.child(method))
                    .with_context(|| format!("{} operation", method.to_ascii_uppercase()))?;
            }
        }
        Ok(())
    }

    fn operation(&mut self, value: &mut Value, source: &Location) -> Result<()> {
        let operation = object(value)?;
        ensure!(
            !operation.contains_key("$ref"),
            "reference a path item instead of an operation"
        );
        if let Some(parameters) = operation.get_mut("parameters") {
            self.parameters(parameters, &source.child("parameters"))?;
        }
        if let Some(body) = operation.get_mut("requestBody") {
            let source = self.resolve_object(body, &source.child("requestBody"))?;
            self.media(object(body)?.get_mut("content"), &source.child("content"))?;
        }
        let responses = operation
            .get_mut("responses")
            .context("missing responses")?;
        let responses = object(responses)?;
        responses.retain(|status, _| !status.starts_with("x-"));
        ensure!(!responses.is_empty(), "at least one response is required");
        for (status, response) in responses {
            ensure!(
                valid_response_key(status),
                "invalid response status {status:?}"
            );
            let source = self.resolve_object(response, &source.child("responses").child(status))?;
            let content = object(response)?.get_mut("content");
            if matches!(status.as_str(), "204" | "205") {
                ensure!(
                    content
                        .as_deref()
                        .is_none_or(|media| media.as_object().is_some_and(Map::is_empty)),
                    "HTTP {status} cannot carry a response body"
                );
            }
            self.media(content, &source.child("content"))?;
        }
        Ok(())
    }

    fn parameters(&mut self, value: &mut Value, source: &Location) -> Result<()> {
        let parameters = value
            .as_array_mut()
            .context("parameters must be an array")?;
        for (index, parameter) in parameters.iter_mut().enumerate() {
            let source = self.resolve_object(parameter, &source.child(&index.to_string()))?;
            let parameter = object(parameter)?;
            ensure!(
                !parameter.contains_key("content"),
                "parameter content is unsupported; use schema"
            );
            let schema = parameter
                .get_mut("schema")
                .context("parameter is missing its schema")?;
            self.schema(schema, &source.child("schema"), 0)?;
        }
        Ok(())
    }

    fn media(&mut self, value: Option<&mut Value>, source: &Location) -> Result<()> {
        if let Some(value) = value {
            for (media_type, media) in object(value)? {
                if let Some(schema) = object(media)?.get_mut("schema") {
                    self.schema(schema, &source.child(media_type).child("schema"), 0)?;
                }
            }
        }
        Ok(())
    }

    fn security_schemes(&mut self, value: &mut Value, source: &Location) -> Result<()> {
        for (name, scheme) in object(value)? {
            self.resolve_object(scheme, &source.child(name))
                .with_context(|| format!("security scheme {name:?}"))?;
        }
        Ok(())
    }

    fn resolve_object(&mut self, value: &mut Value, source: &Location) -> Result<Location> {
        let mut source = source.clone();
        let mut seen = BTreeSet::new();
        while let Some(reference) = object(value)?.get("$ref") {
            let reference = reference.as_str().context("$ref must be a string")?;
            source = self.documents.resolve(&source, reference)?;
            ensure!(
                seen.insert(source.clone()),
                "cyclic non-schema reference at {}#{}",
                source.path.display(),
                source.pointer
            );
            ensure!(
                seen.len() <= MAX_REFERENCE_CHAIN,
                "non-schema reference chain is too deep"
            );
            *value = self.documents.get(&source)?;
        }
        Ok(source)
    }

    fn schema(&mut self, value: &mut Value, source: &Location, depth: usize) -> Result<()> {
        ensure!(
            depth <= MAX_SCHEMA_DEPTH,
            "inline schema nesting exceeds the supported limit"
        );
        let schema = object(value).with_context(|| {
            format!(
                "expected a schema object at {}#{}",
                source.path.display(),
                source.pointer
            )
        })?;
        for keyword in [
            "$id",
            "$anchor",
            "$dynamicRef",
            "$dynamicAnchor",
            "$recursiveRef",
            "$recursiveAnchor",
        ] {
            ensure!(
                !schema.contains_key(keyword),
                "unsupported JSON Schema keyword {keyword} at {}",
                source.pointer
            );
        }
        if let Some(dialect) = schema.get("$schema") {
            ensure!(
                matches!(self.dialect, Dialect::OpenApi31) && supported_dialect(dialect),
                "unsupported $schema {dialect} at {}",
                source.pointer
            );
        }
        if let Some(reference) = schema.get("$ref") {
            let reference = reference.as_str().context("$ref must be a string")?;
            let target = self.documents.resolve(source, reference)?;
            // OpenAPI 3.0 Reference Objects ignore siblings. OpenAPI 3.1 Schema
            // Objects evaluate them, so reject substantive siblings we cannot lower.
            if matches!(self.dialect, Dialect::OpenApi31) {
                ensure!(
                    schema.keys().all(|key| is_annotation(key) || key == "$ref"),
                    "OpenAPI 3.1 schema $ref with validation siblings is unsupported at {}",
                    source.pointer
                );
            }
            let name = self.schema_name(target)?;
            if matches!(self.dialect, Dialect::OpenApi30) {
                schema.clear();
            }
            schema.insert(
                "$ref".into(),
                Value::String(format!("{SCHEMA_REF_PREFIX}{name}")),
            );
            return Ok(());
        }

        normalize_type(schema, self.dialect)
            .with_context(|| format!("schema at {}", source.pointer))?;

        for keyword in ["items", "additionalProperties"] {
            if let Some(child) = schema.get_mut(keyword) {
                if keyword == "additionalProperties" && child.is_boolean() {
                    continue;
                }
                self.schema(child, &source.child(keyword), depth + 1)?;
            }
        }
        for keyword in ["properties", "$defs"] {
            if let Some(children) = schema.get_mut(keyword) {
                let base = source.child(keyword);
                for (name, child) in object(children)? {
                    self.schema(child, &base.child(name), depth + 1)?;
                }
            }
        }
        for keyword in ["allOf", "anyOf", "oneOf"] {
            if let Some(children) = schema.get_mut(keyword) {
                let children = children
                    .as_array_mut()
                    .with_context(|| format!("{keyword} must be an array"))?;
                ensure!(!children.is_empty(), "{keyword} must not be empty");
                for (index, child) in children.iter_mut().enumerate() {
                    self.schema(
                        child,
                        &source.child(keyword).child(&index.to_string()),
                        depth + 1,
                    )?;
                }
            }
        }
        Ok(())
    }

    fn schema_name(&mut self, location: Location) -> Result<String> {
        if let Some(name) = self.schema_names.get(&location) {
            return Ok(name.clone());
        }
        ensure!(
            self.schema_names.len() < MAX_SCHEMAS,
            "too many referenced schemas"
        );
        self.documents.reject_base_uri_ancestors(&location)?;
        let hint = location
            .pointer
            .split('/')
            .next_back()
            .filter(|part| !part.is_empty())
            .or_else(|| location.path.file_stem().and_then(|stem| stem.to_str()))
            .unwrap_or("Schema");
        let hint = hint
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character
                } else {
                    '_'
                }
            })
            .take(64)
            .collect::<String>();
        let base = format!("Referenced_{hint}");
        let mut name = base.clone();
        let mut suffix = 2;
        while !self.used_names.insert(name.clone()) {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        self.schema_names.insert(location.clone(), name.clone());
        self.pending.push_back((name.clone(), location));
        Ok(name)
    }

    fn schemas(mut self) -> Result<BTreeMap<String, super::Schema>> {
        let mut schemas = BTreeMap::new();
        while let Some((name, source)) = self.pending.pop_front() {
            let mut value = self
                .documents
                .get(&source)
                .with_context(|| format!("resolve schema {name:?}"))?;
            self.schema(&mut value, &source, 0).with_context(|| {
                format!(
                    "schema {name:?} at {}#{}",
                    source.path.display(),
                    source.pointer
                )
            })?;
            schemas.insert(
                name.clone(),
                serde_json::from_value(value)
                    .with_context(|| format!("invalid schema {name:?}"))?,
            );
        }
        ensure_no_alias_cycles(&schemas)?;
        Ok(schemas)
    }
}

fn ensure_no_alias_cycles(schemas: &BTreeMap<String, super::Schema>) -> Result<()> {
    let mut resolved = BTreeSet::new();
    for name in schemas.keys() {
        let mut chain = BTreeSet::new();
        let mut current = name.as_str();
        while !resolved.contains(current) {
            ensure!(
                chain.insert(current),
                "schema reference cycle with no concrete shape at {current:?}"
            );
            let Some(reference) = schemas[current].reference.as_deref() else {
                break;
            };
            current = reference
                .strip_prefix(SCHEMA_REF_PREFIX)
                .context("invalid normalized schema reference")?;
        }
        resolved.extend(chain);
    }
    Ok(())
}

fn normalize_type(schema: &mut Map<String, Value>, dialect: Dialect) -> Result<()> {
    if matches!(dialect, Dialect::OpenApi30) {
        ensure!(
            !schema.get("type").is_some_and(Value::is_array),
            "OpenAPI 3.0 schema type must be a string"
        );
        return Ok(());
    }

    ensure!(
        !schema.contains_key("nullable"),
        "OpenAPI 3.1 uses a null type instead of nullable"
    );
    let Some(types) = schema.get("type").and_then(Value::as_array) else {
        return Ok(());
    };
    let count = types.len();
    let types = types
        .iter()
        .map(|value| value.as_str().context("schema types must be strings"))
        .collect::<Result<BTreeSet<_>>>()?;
    ensure!(!types.is_empty(), "schema type array must not be empty");
    ensure!(
        types.len() == count,
        "schema type array contains duplicate types"
    );
    let shape = match types.len() {
        1 => *types.first().context("missing schema type")?,
        2 if types.contains("null") => *types
            .iter()
            .find(|kind| **kind != "null")
            .context("missing non-null type")?,
        _ => bail!("only a single type with optional null is supported in OpenAPI 3.1 type arrays"),
    };
    let nullable = types.contains("null") && shape != "null";
    schema.insert("type".into(), Value::String(shape.to_owned()));
    if nullable {
        schema.insert("nullable".into(), Value::Bool(true));
    }
    Ok(())
}

fn supported_dialect(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "https://json-schema.org/draft/2020-12/schema"
                | "https://spec.openapis.org/oas/3.1/dialect/base"
        )
    )
}

fn is_annotation(key: &str) -> bool {
    matches!(
        key,
        "title"
            | "description"
            | "default"
            | "examples"
            | "example"
            | "deprecated"
            | "readOnly"
            | "writeOnly"
            | "$comment"
            | "$schema"
    ) || key.starts_with("x-")
}

fn valid_response_key(key: &str) -> bool {
    key == "default"
        || matches!(
            key.as_bytes(),
            [b'1'..=b'5', b'X', b'X'] | [b'1'..=b'5', b'0'..=b'9', b'0'..=b'9']
        )
}

fn object(value: &mut Value) -> Result<&mut Map<String, Value>> {
    value.as_object_mut().context("expected an object")
}

fn take(value: &mut Map<String, Value>, key: &str) -> Result<Value> {
    value.remove(key).with_context(|| format!("missing {key}"))
}

impl Location {
    fn child(&self, name: &str) -> Self {
        Self {
            path: self.path.clone(),
            pointer: format!("{}/{}", self.pointer, escape_token(name)),
        }
    }
}
