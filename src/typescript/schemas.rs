use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::openapi::Schema;

#[derive(Serialize)]
pub(crate) struct Model {
    name: String,
    fields: Vec<Field>,
    type_alias: Option<String>,
    imports: BTreeSet<ModelImport>,
}

impl Model {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn is_type_alias(&self) -> bool {
        self.type_alias.is_some()
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub(super) struct ModelImport {
    name: String,
    is_type_alias: bool,
}

#[derive(Serialize)]
pub(super) struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub type_expression: String,
    pub optional: bool,
}

pub(super) struct SchemaTypes<'a> {
    schemas: &'a BTreeMap<String, Schema>,
    names: BTreeMap<&'a str, ModelImport>,
}

impl<'a> SchemaTypes<'a> {
    pub fn new(
        schemas: &'a BTreeMap<String, Schema>,
        interface_prefix: &str,
        event_type: &str,
    ) -> Result<Self> {
        reject_alias_cycles(schemas)?;
        let mut allocated = BTreeSet::new();
        let mut names = BTreeMap::new();
        for (raw, schema) in schemas {
            let mut name = super::identifier(raw);
            let is_type_alias = !is_interface(schema);
            if !is_type_alias {
                name = super::interface_name(interface_prefix, &name);
            }
            ensure!(
                super::valid_identifier(&name) && !name.starts_with("$quivra"),
                "unsupported TypeScript schema name {raw:?} -> {name}"
            );
            ensure!(
                name != event_type && allocated.insert(name.clone()),
                "schema name collision after TypeScript projection: {raw:?} -> {name}"
            );
            names.insert(
                raw.as_str(),
                ModelImport {
                    name,
                    is_type_alias,
                },
            );
        }
        Ok(Self { schemas, names })
    }

    pub fn is_scalar(&self, schema: &Schema) -> bool {
        let mut current = schema;
        for _ in 0..=self.schemas.len() {
            if current.nullable {
                return false;
            }
            if let Some(reference) = &current.reference {
                let Some(target) = reference
                    .strip_prefix("#/components/schemas/")
                    .and_then(|key| self.schemas.get(key))
                else {
                    return false;
                };
                current = target;
                continue;
            }
            return matches!(
                current.kind.as_deref(),
                Some("string" | "integer" | "number" | "boolean")
            );
        }
        false
    }

    pub fn models(&self) -> Result<Vec<Model>> {
        self.schemas
            .iter()
            .map(|(name, schema)| {
                self.model(name, schema)
                    .with_context(|| format!("schema {name:?}"))
            })
            .collect()
    }

    fn model(&self, name: &str, schema: &Schema) -> Result<Model> {
        validate_shape(schema)?;
        let declaration = &self.names[name];
        let mut imports = BTreeSet::new();
        let (fields, type_alias) = if declaration.is_type_alias {
            let expression = self.expression(schema, &mut imports)?;
            (Vec::new(), Some(expression))
        } else {
            (self.fields(schema, &mut imports)?, None)
        };
        imports.remove(declaration);
        Ok(Model {
            name: declaration.name.clone(),
            fields,
            type_alias,
            imports,
        })
    }

    pub fn expression(
        &self,
        schema: &Schema,
        imports: &mut BTreeSet<ModelImport>,
    ) -> Result<String> {
        validate_shape(schema)?;
        let mut parts = Vec::new();
        if let Some(reference) = &schema.reference {
            let key = reference
                .strip_prefix("#/components/schemas/")
                .with_context(|| format!("unsupported schema reference {reference:?}"))?;
            let reference = self
                .names
                .get(key)
                .with_context(|| format!("unknown schema reference {reference:?}"))?;
            imports.insert(reference.clone());
            parts.push(reference.name.clone());
        }

        if let Some(value) = schema.other.get("const") {
            parts.push(literal(value)?);
        }
        if !schema.values.is_empty() {
            let literals = schema
                .values
                .iter()
                .map(literal)
                .collect::<Result<BTreeSet<_>>>()?;
            parts.push(literals.into_iter().collect::<Vec<_>>().join(" | "));
        }
        if parts.is_empty() || schema.kind.is_some() || is_object(schema) {
            let base = self.base(schema, imports)?;
            if let Some(mut expression) = base {
                if schema.nullable {
                    expression.push_str(" | null");
                }
                parts.push(expression);
            }
        }
        for (keyword, separator) in [("allOf", " & "), ("anyOf", " | "), ("oneOf", " | ")] {
            if let Some(alternatives) = schema.other.get(keyword) {
                let alternatives: Vec<Schema> = serde_json::from_value(alternatives.clone())
                    .with_context(|| format!("invalid {keyword} schemas"))?;
                ensure!(
                    !alternatives.is_empty(),
                    "{keyword} requires at least one schema"
                );
                let alternatives = alternatives
                    .iter()
                    .map(|alternative| Ok(format!("({})", self.expression(alternative, imports)?)))
                    .collect::<Result<Vec<_>>>()?;
                parts.push(alternatives.join(separator));
            }
        }
        Ok(match parts.as_slice() {
            [] => "unknown".into(),
            [only] => only.clone(),
            _ => parts
                .iter()
                .map(|part| format!("({part})"))
                .collect::<Vec<_>>()
                .join(" & "),
        })
    }

    fn base(&self, schema: &Schema, imports: &mut BTreeSet<ModelImport>) -> Result<Option<String>> {
        let expression = match schema.kind.as_deref() {
            Some("string") => "string".into(),
            Some("integer" | "number") => "number".into(),
            Some("boolean") => "boolean".into(),
            Some("null") => "null".into(),
            Some("array") => {
                let items = schema.items.as_ref().context("array requires items")?;
                format!("({})[]", self.expression(items, imports)?)
            }
            Some("object") => self.object_expression(schema, imports)?,
            None if is_object(schema) => self.object_expression(schema, imports)?,
            None => return Ok(None),
            Some(kind) => bail!("unsupported schema type {kind:?}"),
        };
        Ok(Some(expression))
    }

    fn object_expression(
        &self,
        schema: &Schema,
        imports: &mut BTreeSet<ModelImport>,
    ) -> Result<String> {
        let fields = self.fields(schema, imports)?;
        let mut entries = Vec::new();
        for field in &fields {
            let name = serde_json::to_string(&field.name)?;
            let optional = if field.optional { "?" } else { "" };
            entries.push(format!("{name}{optional}: {}", field.type_expression));
        }

        if let Some(value) = additional(schema) {
            let additional_type = match value {
                Value::Bool(false) => None,
                Value::Bool(true) => Some("unknown".into()),
                _ => {
                    let additional: Schema = serde_json::from_value(value.clone())
                        .context("invalid additionalProperties schema")?;
                    Some(self.expression(&additional, imports)?)
                }
            };
            if let Some(additional_type) = additional_type {
                let mut values = BTreeSet::from([additional_type]);
                values.extend(fields.iter().map(|field| field.type_expression.clone()));
                if fields.iter().any(|field| field.optional) {
                    values.insert("undefined".into());
                }
                let value_type = values.into_iter().collect::<Vec<_>>().join(" | ");
                entries.push(format!("[key: string]: {value_type}"));
            }
        }
        if entries.is_empty() {
            return Ok("{ [key: string]: unknown }".into());
        }
        Ok(format!("{{ {} }}", entries.join("; ")))
    }

    fn fields(&self, schema: &Schema, imports: &mut BTreeSet<ModelImport>) -> Result<Vec<Field>> {
        ensure!(
            schema
                .required
                .iter()
                .all(|name| schema.properties.contains_key(name)),
            "required names must be declared in properties"
        );
        schema
            .properties
            .iter()
            .map(|(name, field)| {
                Ok(Field {
                    name: name.clone(),
                    type_expression: self
                        .expression(field, imports)
                        .with_context(|| format!("property {name:?}"))?,
                    optional: !schema.required.contains(name),
                })
            })
            .collect()
    }
}

fn reject_alias_cycles(schemas: &BTreeMap<String, Schema>) -> Result<()> {
    let mut dependants = BTreeMap::<String, Vec<&str>>::new();
    let mut outstanding = BTreeMap::new();
    for (name, schema) in schemas {
        let mut dependencies = BTreeSet::new();
        collect_alias_dependencies(schema, &mut dependencies)?;
        dependencies.retain(|dependency| schemas.contains_key(dependency));
        outstanding.insert(name.as_str(), dependencies.len());
        for dependency in dependencies {
            dependants.entry(dependency).or_default().push(name);
        }
    }

    let mut ready = outstanding
        .iter()
        .filter_map(|(&name, &count)| (count == 0).then_some(name))
        .collect::<VecDeque<_>>();
    while let Some(name) = ready.pop_front() {
        outstanding.remove(name);
        for next in dependants.get(name).into_iter().flatten() {
            if let Some(count) = outstanding.get_mut(next) {
                *count -= 1;
                if *count == 0 {
                    ready.push_back(next);
                }
            }
        }
    }

    if let Some((name, _)) = outstanding.first_key_value() {
        bail!("schema {name:?} has an unguarded recursive type alias");
    }
    Ok(())
}

fn collect_alias_dependencies(schema: &Schema, dependencies: &mut BTreeSet<String>) -> Result<()> {
    if let Some(reference) = &schema.reference {
        let name = reference
            .strip_prefix("#/components/schemas/")
            .with_context(|| format!("unsupported schema reference {reference:?}"))?;
        dependencies.insert(name.to_owned());
    }
    // Object properties and array elements introduce a structural guard.
    for keyword in ["allOf", "anyOf", "oneOf"] {
        if let Some(alternatives) = schema.other.get(keyword) {
            let alternatives: Vec<Schema> = serde_json::from_value(alternatives.clone())
                .with_context(|| format!("invalid {keyword} schemas"))?;
            for alternative in &alternatives {
                collect_alias_dependencies(alternative, dependencies)?;
            }
        }
    }
    Ok(())
}

fn validate_shape(schema: &Schema) -> Result<()> {
    for keyword in [
        "not",
        "if",
        "then",
        "else",
        "prefixItems",
        "patternProperties",
        "unevaluatedProperties",
        "dependentSchemas",
    ] {
        ensure!(
            !schema.other.contains_key(keyword),
            "unsupported schema keyword {keyword}"
        );
    }
    Ok(())
}

fn is_interface(schema: &Schema) -> bool {
    is_object(schema)
        && !schema.nullable
        && schema.reference.is_none()
        && schema.values.is_empty()
        && ["const", "allOf", "anyOf", "oneOf"]
            .iter()
            .all(|key| !schema.other.contains_key(*key))
        && additional(schema).is_none_or(|value| *value == Value::Bool(false))
}

fn is_object(schema: &Schema) -> bool {
    schema.kind.as_deref() == Some("object")
        || (schema.kind.is_none()
            && (!schema.properties.is_empty() || additional(schema).is_some()))
}

fn additional(schema: &Schema) -> Option<&Value> {
    schema.other.get("additionalProperties")
}

fn literal(value: &Value) -> Result<String> {
    ensure!(
        !value.is_object() && !value.is_array(),
        "object and array schema literals are unsupported"
    );
    Ok(serde_json::to_string(value)?)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn schema(value: Value) -> Schema {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn projects_refs_compositions_nullable_types_and_aliases() {
        let schemas = BTreeMap::from([
            (
                "Event-Payload".into(),
                schema(json!({
                    "type":"object",
                    "properties":{"text":{"type":"string","nullable":true}}
                })),
            ),
            (
                "Event-Result".into(),
                schema(json!({
                    "anyOf":[{"$ref":"#/components/schemas/Event-Payload"},{"const":"queued"}]
                })),
            ),
        ]);
        let types = SchemaTypes::new(&schemas, "I", "IQuivraEvent").unwrap();
        let models = types.models().unwrap();
        assert_eq!(models[0].name, "IEvent_Payload");
        assert!(models[0].imports.is_empty());
        assert_eq!(
            models[1]
                .imports
                .iter()
                .next()
                .map(|dependency| (dependency.name.as_str(), dependency.is_type_alias)),
            Some(("IEvent_Payload", false))
        );
        assert_eq!(models[0].fields[0].type_expression, "string | null");
        assert_eq!(
            models[1].type_alias.as_deref(),
            Some(r#"(IEvent_Payload) | ("queued")"#)
        );
    }

    #[test]
    fn keeps_existing_interface_prefixes_and_rejects_projected_name_collisions() {
        let mut schemas = BTreeMap::from([("IWidget".into(), schema(json!({"type":"object"})))]);
        let types = SchemaTypes::new(&schemas, "I", "IQuivraEvent").unwrap();
        assert_eq!(types.models().unwrap()[0].name(), "IWidget");
        schemas.insert("Widget".into(), schema(json!({"type":"object"})));
        let error = SchemaTypes::new(&schemas, "I", "IQuivraEvent")
            .err()
            .unwrap();
        assert!(error.to_string().contains("schema name collision"));
    }

    #[test]
    fn rejects_unguarded_composition_cycles_and_preserves_recursive_fields() {
        let mut schemas = BTreeMap::from([(
            "Node".into(),
            schema(json!({
                "type":"object",
                "properties":{"next":{"$ref":"#/components/schemas/Node"}}
            })),
        )]);
        assert!(
            SchemaTypes::new(&schemas, "", "QuivraEvent")
                .unwrap()
                .models()
                .is_ok()
        );
        schemas.insert(
            "Node".into(),
            schema(json!({
                "allOf":[{"$ref":"#/components/schemas/Node"}]
            })),
        );
        let error = SchemaTypes::new(&schemas, "", "QuivraEvent").err().unwrap();
        assert!(error.to_string().contains("unguarded recursive type alias"));
    }
}
