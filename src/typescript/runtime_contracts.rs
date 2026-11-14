use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

const DEF_NAMESPACE: &str = "__openapi_components__";
const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";
const ALGORITHM: &str = "json-schema-validation-sha256-v1";
const MARKER: &str = "x-assistant-action";
const ACTION_FIELDS: [&str; 6] = [
    "actionKey",
    "contractVersion",
    "executionScope",
    "fingerprintAlgorithm",
    "payload",
    "payloadSchemaFingerprint",
];
const DERIVED_KEYWORDS: [&str; 8] = [
    "$ref", "allOf", "anyOf", "oneOf", "not", "if", "then", "else",
];

#[derive(Serialize)]
pub(super) struct RuntimeContracts {
    definitions: Value,
    schemas: BTreeMap<String, String>,
    actions: BTreeMap<String, Action>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Action {
    action_key: String,
    contract_version: u64,
    execution_scope: String,
    fingerprint_algorithm: &'static str,
    payload_schema: String,
    payload_schema_fingerprint: String,
}

pub(super) fn project(
    schemas: &Map<String, Value>,
    openapi30: bool,
    model_name: impl Fn(&str) -> Option<String>,
) -> Result<RuntimeContracts> {
    let mut actions = BTreeMap::new();
    let mut roots = BTreeSet::new();
    for (component, source) in schemas {
        match source.get(MARKER) {
            None | Some(Value::Bool(false)) => continue,
            Some(Value::Bool(true)) => {}
            Some(_) => bail!("runtime action {component:?} must declare a Boolean {MARKER}"),
        }
        let action = parse_action(schemas, openapi30, source, &model_name)
            .with_context(|| format!("runtime action {component:?}"))?;
        let key = action.action_key.clone();
        ensure!(
            actions.insert(key.clone(), action).is_none(),
            "duplicate runtime action {key:?}"
        );
        roots.insert(component.clone());
    }
    let definitions = closure(schemas, openapi30, roots)?;
    let mut entries = BTreeMap::new();
    for component in definitions.keys() {
        let name = model_name(component)
            .with_context(|| format!("runtime schema {component:?} has no TypeScript model"))?;
        ensure!(
            entries
                .insert(name.clone(), component_reference(component, &[]))
                .is_none(),
            "duplicate runtime schema type name {name:?}"
        );
    }
    Ok(RuntimeContracts {
        definitions: json!({ DEF_NAMESPACE: { "$defs": definitions } }),
        schemas: entries,
        actions,
    })
}

fn parse_action(
    schemas: &Map<String, Value>,
    openapi30: bool,
    source: &Value,
    model_name: &impl Fn(&str) -> Option<String>,
) -> Result<Action> {
    ensure!(
        source.get("type").and_then(Value::as_str) == Some("object")
            && source.get("additionalProperties").and_then(Value::as_bool) == Some(false)
            && DERIVED_KEYWORDS.iter().all(|key| source.get(key).is_none()),
        "expected a direct object schema with additionalProperties set to false"
    );
    let properties = source
        .get("properties")
        .and_then(Value::as_object)
        .context("missing properties")?;
    let required = string_set(source.get("required").context("missing required fields")?)?;
    let expected = BTreeSet::from(ACTION_FIELDS);
    ensure!(
        required == expected
            && properties
                .keys()
                .map(String::as_str)
                .collect::<BTreeSet<_>>()
                == expected,
        "expected exactly the canonical runtime action fields"
    );
    let field = |name: &str| {
        singleton(&properties[name], schemas)
            .with_context(|| format!("invalid runtime action field {name}"))
    };
    let action_key = field("actionKey")?
        .as_str()
        .context("expected an action key string")?;
    ensure!(
        action_key.len() <= 128
            && action_key
                .split(['.', '-'])
                .all(|segment| !segment.is_empty()
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())),
        "invalid runtime action key {action_key:?}"
    );
    let contract_version = field("contractVersion")?
        .as_u64()
        .filter(|value| (1..=9_007_199_254_740_991).contains(value))
        .context("contractVersion must be a positive safe integer")?;
    let execution_scope = field("executionScope")?
        .as_str()
        .filter(|scope| matches!(*scope, "application" | "view"))
        .context("invalid executionScope")?;
    ensure!(
        field("fingerprintAlgorithm")?.as_str() == Some(ALGORITHM),
        "expected fingerprint algorithm {ALGORITHM}"
    );
    let payload = component_root(&properties["payload"])?;
    let payload_schema =
        model_name(&payload).with_context(|| format!("no payload model for {payload:?}"))?;
    let payload_schema_fingerprint = fingerprint(schemas, openapi30, &payload)?;
    ensure!(
        field("payloadSchemaFingerprint")?.as_str() == Some(&payload_schema_fingerprint),
        "payload schema fingerprint does not match {payload_schema_fingerprint}"
    );
    Ok(Action {
        action_key: action_key.to_owned(),
        contract_version,
        execution_scope: execution_scope.to_owned(),
        fingerprint_algorithm: ALGORITHM,
        payload_schema,
        payload_schema_fingerprint,
    })
}

fn singleton<'a>(source: &'a Value, schemas: &'a Map<String, Value>) -> Result<&'a Value> {
    let mut visited = BTreeSet::new();
    let mut schema = source;
    while schema.get("$ref").is_some() {
        let component = component_root(schema)?;
        ensure!(
            visited.insert(component.clone()),
            "cyclic singleton reference"
        );
        schema = schemas
            .get(&component)
            .with_context(|| format!("missing singleton component {component:?}"))?;
    }
    ensure!(
        schema.is_object() && DERIVED_KEYWORDS.iter().all(|key| schema.get(key).is_none()),
        "expected a direct singleton schema"
    );
    let enumerated = if let Some(value) = schema.get("enum") {
        let values = value
            .as_array()
            .filter(|values| values.len() == 1)
            .context("expected exactly one enum value")?;
        Some(&values[0])
    } else {
        None
    };
    let declared = schema.get("const");
    if let (Some(constant), Some(member)) = (declared, enumerated) {
        ensure!(constant == member, "conflicting const and enum values");
    }
    let value = declared
        .or(enumerated)
        .context("expected const or a singleton enum")?;
    if let Some(data_type) = schema.get("type") {
        let matches = |kind: &Value| match kind.as_str() {
            Some("string") => value.is_string(),
            Some("integer") => value.as_f64().is_some_and(|number| number.fract() == 0.0),
            Some("number") => value.is_number(),
            Some("null") => value.is_null(),
            Some("object") => value.is_object(),
            Some("array") => value.is_array(),
            Some("boolean") => value.is_boolean(),
            _ => false,
        };
        ensure!(
            matches(data_type)
                || data_type
                    .as_array()
                    .is_some_and(|kinds| kinds.iter().any(matches)),
            "singleton value does not match its schema type"
        );
    }
    Ok(value)
}

fn component_root(schema: &Value) -> Result<String> {
    let reference = schema
        .as_object()
        .filter(|entries| entries.len() == 1)
        .and_then(|entries| entries.get("$ref"))
        .and_then(Value::as_str)
        .context("expected an exact component-root $ref")?;
    let pointer = parse_pointer(reference)?;
    match pointer.as_slice() {
        [components, schemas, root] if components == "components" && schemas == "schemas" => {
            Ok(root.clone())
        }
        _ => bail!("expected an exact component-root $ref, got {reference:?}"),
    }
}

fn fingerprint(schemas: &Map<String, Value>, openapi30: bool, component: &str) -> Result<String> {
    let source = schemas
        .get(component)
        .with_context(|| format!("missing payload component {component:?}"))?;
    let mut normalization = Normalization::new(openapi30, None);
    let mut root = normalization.schema(source)?;
    if let Some(entries) = root.as_object_mut() {
        let nested = entries.get("$defs").and_then(Value::as_object);
        ensure!(
            nested.is_none_or(|map| !map.contains_key(DEF_NAMESPACE)),
            "reserved runtime definition name {DEF_NAMESPACE}"
        );
        if !normalization.dependencies.is_empty() {
            let mut nested = nested.cloned().unwrap_or_default();
            let referenced = closure(schemas, openapi30, normalization.dependencies)?;
            nested.insert(DEF_NAMESPACE.into(), json!({ "$defs": referenced }));
            entries.insert("$defs".into(), Value::Object(nested));
        }
    }
    let canonical = canonical_json(&root);
    Ok(Sha256::digest(canonical.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn closure(
    schemas: &Map<String, Value>,
    openapi30: bool,
    mut pending: BTreeSet<String>,
) -> Result<BTreeMap<String, Value>> {
    let mut definitions = BTreeMap::new();
    while let Some(component) = pending.pop_first() {
        if definitions.contains_key(&component) {
            continue;
        }
        let source = schemas
            .get(&component)
            .with_context(|| format!("missing runtime schema {component:?}"))?;
        let mut normalization = Normalization::new(openapi30, Some(&component));
        let normalized = normalization
            .schema(source)
            .with_context(|| format!("runtime schema {component:?}"))?;
        pending.extend(normalization.dependencies);
        definitions.insert(component, normalized);
    }
    Ok(definitions)
}

struct Normalization<'a> {
    openapi30: bool,
    /// References to local definitions are rebased when embedding a component in a registry.
    component: Option<&'a str>,
    dependencies: BTreeSet<String>,
}

impl<'a> Normalization<'a> {
    fn new(openapi30: bool, component: Option<&'a str>) -> Self {
        Self {
            openapi30,
            component,
            dependencies: BTreeSet::new(),
        }
    }

    fn schema(&mut self, source: &Value) -> Result<Value> {
        if source.is_boolean() {
            return Ok(source.clone());
        }
        let source = source
            .as_object()
            .context("expected a JSON schema object or Boolean")?;
        if self.openapi30 && source.contains_key("$ref") {
            ensure!(
                source.len() == 1,
                "OpenAPI 3.0 does not apply $ref siblings"
            );
        }
        let mut output = Map::new();
        for (key, value) in source {
            let normalized = self
                .keyword(key, value)
                .with_context(|| format!("runtime schema keyword {key:?}"))?;
            if let Some(normalized) = normalized {
                output.insert(key.clone(), normalized);
            }
        }
        if self.openapi30 {
            for (exclusive, inclusive) in [
                ("exclusiveMaximum", "maximum"),
                ("exclusiveMinimum", "minimum"),
            ] {
                if source.get(exclusive).and_then(Value::as_bool) == Some(true) {
                    let bound = output
                        .remove(inclusive)
                        .with_context(|| format!("{exclusive} needs {inclusive}"))?;
                    output.insert(exclusive.into(), bound);
                }
            }
            if source.get("nullable").and_then(Value::as_bool) == Some(true) {
                let data_type = output
                    .get_mut("type")
                    .context("nullable requires an explicit type")?;
                let mut types: BTreeSet<String> = if let Some(kind) = data_type.as_str() {
                    BTreeSet::from([kind.into()])
                } else {
                    string_set(data_type)?
                        .into_iter()
                        .map(str::to_owned)
                        .collect()
                };
                types.insert("null".into());
                *data_type = json!(types);
            }
        }
        if let Some(items) = source.get("items").and_then(Value::as_array) {
            ensure!(
                !source.contains_key("prefixItems"),
                "tuple items conflicts with prefixItems"
            );
            output.insert("prefixItems".into(), self.schema_array(items, false)?);
            output.insert(
                "items".into(),
                self.schema(source.get("additionalItems").unwrap_or(&Value::Bool(true)))?,
            );
        }
        Ok(Value::Object(output))
    }

    fn keyword(&mut self, key: &str, value: &Value) -> Result<Option<Value>> {
        let normalized = match key {
            "$comment" | "default" | "deprecated" | "description" | "discriminator" | "example"
            | "examples" | "externalDocs" | "readOnly" | "title" | "writeOnly" | "xml" => {
                return Ok(None);
            }
            "$schema" => {
                ensure!(
                    value.as_str() == Some(DIALECT),
                    "unsupported schema dialect"
                );
                return Ok(None);
            }
            "$ref" => json!(
                self.rewrite_reference(value.as_str().context("expected a string reference")?)?
            ),
            "nullable" => {
                ensure!(
                    self.openapi30 && value.is_boolean(),
                    "nullable requires a Boolean in OpenAPI 3.0"
                );
                return Ok(None);
            }
            "additionalItems" => return Ok(None),
            "const" => value.clone(),
            "enum" => canonical_set(value.as_array().context("expected enum values")?)?,
            "type" => normalize_type(value)?,
            "required" => json!(string_set(value)?),
            "dependentRequired" => {
                let values = value
                    .as_object()
                    .context("expected an object")?
                    .iter()
                    .map(|(name, required)| Ok((name.clone(), json!(string_set(required)?))))
                    .collect::<Result<Map<_, _>>>()?;
                Value::Object(values)
            }
            "allOf" | "anyOf" | "oneOf" | "prefixItems" => self.schema_array(
                value.as_array().context("expected a schema array")?,
                key != "prefixItems",
            )?,
            "$defs" | "dependentSchemas" | "patternProperties" | "properties" => {
                let values = value
                    .as_object()
                    .context("expected schema entries")?
                    .iter()
                    .map(|(name, schema)| {
                        Ok((
                            name.clone(),
                            self.schema(schema)
                                .with_context(|| format!("runtime property {name:?}"))?,
                        ))
                    })
                    .collect::<Result<Map<_, _>>>()?;
                Value::Object(values)
            }
            "items" if value.is_array() => return Ok(None),
            "additionalProperties"
            | "contains"
            | "contentSchema"
            | "else"
            | "if"
            | "items"
            | "not"
            | "propertyNames"
            | "then"
            | "unevaluatedItems"
            | "unevaluatedProperties" => self.schema(value)?,
            "exclusiveMaximum" | "exclusiveMinimum" if self.openapi30 => {
                ensure!(
                    value.is_boolean(),
                    "OpenAPI 3.0 requires a Boolean exclusive bound"
                );
                return Ok(None);
            }
            "maximum" | "minimum" | "exclusiveMaximum" | "exclusiveMinimum" => {
                ensure!(value.is_number(), "expected a numeric bound");
                value.clone()
            }
            "maxContains" | "maxItems" | "maxLength" | "maxProperties" | "minContains"
            | "minItems" | "minLength" | "minProperties" => {
                ensure!(
                    value
                        .as_f64()
                        .is_some_and(|number| (0.0..=9_007_199_254_740_991.0).contains(&number)
                            && number.fract() == 0.0),
                    "expected a non-negative safe integer"
                );
                value.clone()
            }
            "multipleOf" => {
                ensure!(
                    value.as_f64().is_some_and(|number| number > 0.0),
                    "expected a positive number"
                );
                value.clone()
            }
            "contentEncoding" | "contentMediaType" | "format" | "pattern" => {
                ensure!(value.is_string(), "expected a string");
                value.clone()
            }
            "uniqueItems" => {
                ensure!(value.is_boolean(), "expected a Boolean");
                value.clone()
            }
            key if key.starts_with("x-") => return Ok(None),
            _ => bail!("unsupported runtime validation keyword"),
        };
        Ok(Some(normalized))
    }

    fn schema_array(&mut self, schemas: &[Value], commutative: bool) -> Result<Value> {
        ensure!(!schemas.is_empty(), "expected a non-empty schema array");
        let mut normalized = schemas
            .iter()
            .map(|value| self.schema(value))
            .collect::<Result<Vec<_>>>()?;
        if commutative {
            normalized.sort_by_cached_key(canonical_json);
        }
        Ok(Value::Array(normalized))
    }

    fn rewrite_reference(&mut self, reference: &str) -> Result<String> {
        let pointer = parse_pointer(reference)?;
        if matches!(pointer.as_slice(), [components, schemas, ..] if components == "components" && schemas == "schemas")
        {
            let component = pointer
                .get(2)
                .context("reference has no schema component name")?;
            self.dependencies.insert(component.clone());
            return Ok(component_reference(component, &pointer[3..]));
        }
        if let Some(component) = self.component {
            return Ok(component_reference(component, &pointer));
        }
        Ok(encode_pointer(pointer.iter().map(String::as_str)))
    }
}

fn normalize_type(value: &Value) -> Result<Value> {
    let types = if let Some(name) = value.as_str() {
        BTreeSet::from([name])
    } else {
        string_set(value)?
    };
    ensure!(
        !types.is_empty()
            && types.iter().all(|name| matches!(
                *name,
                "array" | "boolean" | "integer" | "null" | "number" | "object" | "string"
            )),
        "unsupported JSON schema type"
    );
    Ok(if value.is_string() {
        value.clone()
    } else {
        json!(types)
    })
}

fn string_set(value: &Value) -> Result<BTreeSet<&str>> {
    let values = value.as_array().context("expected a string array")?;
    let mut sorted = BTreeSet::new();
    for value in values {
        ensure!(
            sorted.insert(value.as_str().context("expected string array entry")?),
            "duplicate string array entry"
        );
    }
    Ok(sorted)
}

fn canonical_set(values: &[Value]) -> Result<Value> {
    ensure!(!values.is_empty(), "expected a non-empty enum array");
    let mut sorted = BTreeMap::new();
    for value in values {
        ensure!(
            sorted
                .insert(canonical_json(value), value.clone())
                .is_none(),
            "duplicate enum member"
        );
    }
    Ok(Value::Array(sorted.into_values().collect()))
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(fields) => format!(
            "{{{}}}",
            fields
                .iter()
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .map(|(key, value)| format!("{}:{}", json!(key), canonical_json(value)))
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Number(value) => canonical_number(value),
        _ => value.to_string(),
    }
}

fn canonical_number(value: &serde_json::Number) -> String {
    let Some(number) = value.as_f64() else {
        return value.to_string();
    };
    if number == 0.0 {
        return "0".into();
    }
    if (1e-6..1e21).contains(&number.abs()) {
        return number.to_string();
    }
    let scientific = format!("{number:e}");
    if let Some((mantissa, exponent)) = scientific.split_once('e')
        && !exponent.starts_with('-')
    {
        return format!("{mantissa}e+{exponent}");
    }
    scientific
}

fn parse_pointer(reference: &str) -> Result<Vec<String>> {
    let input = reference
        .strip_prefix('#')
        .context("external runtime schema reference")?;
    let mut bytes = Vec::with_capacity(input.len());
    let mut source = input.bytes();
    while let Some(byte) = source.next() {
        if byte == b'%' {
            let next_hex = |byte| char::from(byte).to_digit(16);
            let high = source
                .next()
                .and_then(next_hex)
                .context("invalid URI escape")?;
            let low = source
                .next()
                .and_then(next_hex)
                .context("invalid URI escape")?;
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let pointer = String::from_utf8(bytes).context("runtime schema reference must be UTF-8")?;
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    pointer
        .strip_prefix('/')
        .context("expected a JSON Pointer fragment")?
        .split('/')
        .map(|token| {
            let mut decoded = String::new();
            let mut chars = token.chars();
            while let Some(character) = chars.next() {
                decoded.push(if character == '~' {
                    match chars.next() {
                        Some('0') => '~',
                        Some('1') => '/',
                        _ => bail!("invalid JSON Pointer escape"),
                    }
                } else {
                    character
                });
            }
            Ok(decoded)
        })
        .collect()
}

fn component_reference(component: &str, tail: &[String]) -> String {
    encode_pointer(
        ["$defs", DEF_NAMESPACE, "$defs", component]
            .into_iter()
            .chain(tail.iter().map(String::as_str)),
    )
}

fn encode_pointer<'a>(tokens: impl IntoIterator<Item = &'a str>) -> String {
    use std::fmt::Write as _;

    let mut result = String::from("#");
    for token in tokens {
        result.push('/');
        for byte in token.replace('~', "~0").replace('/', "~1").bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                result.push(char::from(byte));
            } else {
                write!(result, "%{byte:02X}").expect("writing to a String cannot fail");
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marked_actions_emit_their_reachable_contract_and_check_its_fingerprint() {
        let mut schemas = json!({
            "Payload": {
                "type": "object",
                "required": ["value"],
                "properties": { "value": { "$ref": "#/components/schemas/Value" } }
            },
            "Value": { "type": "string", "enum": ["b", "a"] },
            "Unrelated": { "unsupported": true },
            "Action": {
                "x-assistant-action": true,
                "type": "object",
                "additionalProperties": false,
                "required": ACTION_FIELDS,
                "properties": {
                    "actionKey": { "const": "test.action" },
                    "contractVersion": { "const": 1 },
                    "executionScope": { "const": "view" },
                    "fingerprintAlgorithm": { "const": ALGORITHM },
                    "payload": { "$ref": "#/components/schemas/Payload" },
                    "payloadSchemaFingerprint": { "const": "" }
                }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let original = fingerprint(&schemas, true, "Payload").unwrap();
        assert_eq!(
            original,
            "44f5179edb02e8f675c1ba3e0dcaa6a935ff589e98d045dd8e65db5892e2ae33"
        );
        schemas.get_mut("Action").unwrap()["properties"]["payloadSchemaFingerprint"]["const"] =
            json!(original);
        let registry = project(&schemas, true, |name| Some(format!("I{name}"))).unwrap();
        assert_eq!(
            registry.actions["test.action"].payload_schema_fingerprint,
            original
        );
        assert_eq!(
            registry.schemas["IPayload"],
            "#/%24defs/__openapi_components__/%24defs/Payload"
        );
        assert!(!registry.schemas.contains_key("IUnrelated"));
        assert_eq!(
            registry.definitions[DEF_NAMESPACE]["$defs"]["Value"]["enum"],
            json!(["a", "b"])
        );
        schemas.get_mut("Value").unwrap()["enum"] = json!(["a"]);
        assert!(project(&schemas, true, |name| Some(format!("I{name}"))).is_err());
    }
}
