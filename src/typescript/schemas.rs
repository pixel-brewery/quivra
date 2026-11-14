use std::collections::{BTreeMap, BTreeSet, VecDeque};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::openapi::Schema;

#[derive(Serialize)]
pub(crate) struct Model {
    name: String,
    raw_name: String,
    description: Option<String>,
    extensions: BTreeMap<String, Value>,
    fields: Vec<Field>,
    type_alias: Option<String>,
    enum_values: Vec<EnumValue>,
    index_signature_type: Option<String>,
    imports: BTreeSet<ModelImport>,
}

impl Model {
    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn is_type_alias(&self) -> bool {
        self.type_alias.is_some()
    }

    pub(crate) fn is_enum(&self) -> bool {
        !self.enum_values.is_empty()
    }

    pub(super) fn raw_name(&self) -> &str {
        &self.raw_name
    }
}

#[derive(Serialize)]
struct EnumValue {
    name: String,
    value: Value,
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub(super) struct ModelImport {
    pub(super) name: String,
    is_type_alias: bool,
}

#[derive(Clone, Serialize)]
pub(super) struct Field {
    pub name: String,
    #[serde(rename = "type")]
    pub type_expression: String,
    pub optional: bool,
    pub deprecated: bool,
    pub description: Option<String>,
}

pub(super) fn retain_used_models<'a>(
    models: &mut Vec<Model>,
    roots: impl IntoIterator<Item = &'a ModelImport>,
) {
    let by_name: BTreeMap<_, _> = models
        .iter()
        .map(|model| (model.name.as_str(), model))
        .collect();
    let mut frontier: Vec<_> = roots.into_iter().map(|root| root.name.as_str()).collect();
    let mut used = BTreeSet::new();
    while let Some(name) = frontier.pop() {
        if used.insert(name)
            && let Some(model) = by_name.get(name)
        {
            frontier.extend(model.imports.iter().map(|model| model.name.as_str()));
        }
    }
    let used: BTreeSet<_> = used.into_iter().map(str::to_owned).collect();
    models.retain(|model| used.contains(&model.name));
}

#[derive(Clone)]
pub(super) struct SchemaTypes<'a> {
    schemas: &'a BTreeMap<String, Schema>,
    names: BTreeMap<&'a str, ModelImport>,
    preserve_nullable_annotations: bool,
    enum_objects: bool,
    multipart_binary: bool,
}

impl<'a> SchemaTypes<'a> {
    pub fn new(
        schemas: &'a BTreeMap<String, Schema>,
        interface_prefix: &str,
        alias_prefix: &str,
        event_type: &str,
        preserve_nullable_annotations: bool,
        enum_objects: bool,
        object_index_interfaces: bool,
    ) -> Result<Self> {
        reject_alias_cycles(schemas)?;
        let mut allocated = BTreeSet::new();
        let mut names = BTreeMap::new();
        for (raw, schema) in schemas {
            let mut name = super::identifier(raw);
            let is_enum = enum_objects && named_enum(schema);
            let is_interface =
                is_interface(schema) || (object_index_interfaces && is_index_interface(schema));
            let is_type_alias = !is_interface && !is_enum;
            if is_type_alias && !alias_prefix.is_empty() {
                name = super::interface_name(alias_prefix, &super::type_name(raw));
            }
            if is_interface {
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
        Ok(Self {
            schemas,
            names,
            preserve_nullable_annotations,
            enum_objects,
            multipart_binary: false,
        })
    }

    pub fn reference_import(&self, schema: &Schema) -> Option<&ModelImport> {
        let name = schema
            .reference
            .as_deref()?
            .strip_prefix("#/components/schemas/")?;
        self.names.get(name)
    }

    pub fn envelope_property(&self, schema: &Schema) -> Option<String> {
        let mut current = schema;
        for _ in 0..=self.schemas.len() {
            if let Some(property) = current
                .other
                .get("x-archipel-envelope")
                .and_then(|extension| {
                    if extension.get("version").and_then(Value::as_u64) != Some(2) {
                        return None;
                    }
                    extension.get("dataProperty").and_then(Value::as_str)
                })
                .filter(|property| !property.is_empty())
            {
                return Some(property.to_owned());
            }
            let name = current
                .reference
                .as_deref()?
                .strip_prefix("#/components/schemas/")?;
            current = self.schemas.get(name)?;
        }
        None
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
        let enum_values = if self.enum_objects && named_enum(schema) {
            enum_members(schema)?
        } else {
            Vec::new()
        };
        let (fields, type_alias) = if declaration.is_type_alias {
            let expression = self.expression(schema, &mut imports)?;
            (Vec::new(), Some(expression))
        } else {
            (self.fields(schema, &mut imports)?, None)
        };
        let index_signature_type = if declaration.is_type_alias || !enum_values.is_empty() {
            None
        } else {
            self.index_signature(schema, &fields, &mut imports)?
        };
        imports.remove(declaration);
        Ok(Model {
            name: declaration.name.clone(),
            raw_name: name.to_owned(),
            description: schema
                .other
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_owned),
            extensions: schema
                .other
                .iter()
                .filter(|(name, _)| name.starts_with("x-"))
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect(),
            fields,
            type_alias,
            enum_values,
            index_signature_type,
            imports,
        })
    }

    pub fn expression_for_multipart(
        &self,
        schema: &Schema,
        imports: &mut BTreeSet<ModelImport>,
    ) -> Result<String> {
        let types = Self {
            multipart_binary: true,
            ..self.clone()
        };
        types.expression(schema, imports)
    }

    pub fn expression(
        &self,
        schema: &Schema,
        imports: &mut BTreeSet<ModelImport>,
    ) -> Result<String> {
        validate_shape(schema)?;
        let mut parts = Vec::new();
        let nullable_result = self.preserve_nullable_annotations && schema.nullable;
        // The compatibility projection allows an explicit nullable annotation
        // to apply to the whole shape, including Swagger-produced composition.
        let has_restricting_shape = !schema.values.is_empty()
            || ["const", "allOf", "anyOf", "oneOf"]
                .iter()
                .any(|keyword| schema.other.contains_key(*keyword));
        let redundant_object = nullable_result
            && has_restricting_shape
            && schema.kind.as_deref() == Some("object")
            && schema.properties.is_empty()
            && additional(schema).is_none();
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
        if !redundant_object && (parts.is_empty() || schema.kind.is_some() || is_object(schema)) {
            let base = self.base(schema, imports)?;
            if let Some(mut expression) = base {
                if schema.nullable && !nullable_result {
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
        let expression = match parts.as_slice() {
            [] => "unknown".into(),
            [only] => only.clone(),
            _ => parts
                .iter()
                .map(|part| format!("({part})"))
                .collect::<Vec<_>>()
                .join(" & "),
        };
        if nullable_result && expression != "null" && expression != "unknown" {
            return Ok(format!("{expression} | null"));
        }
        Ok(expression)
    }

    fn base(&self, schema: &Schema, imports: &mut BTreeSet<ModelImport>) -> Result<Option<String>> {
        let expression = match schema.kind.as_deref() {
            Some("string")
                if self.multipart_binary
                    && schema.other.get("format").and_then(Value::as_str) == Some("binary") =>
            {
                "Blob".into()
            }
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

        if let Some(value_type) = self.index_signature(schema, &fields, imports)? {
            entries.push(format!("[key: string]: {value_type}"));
        }
        if entries.is_empty() {
            return Ok("object".into());
        }
        Ok(format!("{{ {} }}", entries.join("; ")))
    }

    fn index_signature(
        &self,
        schema: &Schema,
        fields: &[Field],
        imports: &mut BTreeSet<ModelImport>,
    ) -> Result<Option<String>> {
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
                return Ok(Some(values.into_iter().collect::<Vec<_>>().join(" | ")));
            }
        }
        Ok(None)
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
                    deprecated: field
                        .other
                        .get("deprecated")
                        .and_then(Value::as_bool)
                        .unwrap_or_default(),
                    description: field
                        .other
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
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
    is_index_interface(schema)
        && additional(schema).is_none_or(|value| *value == Value::Bool(false))
}

fn is_index_interface(schema: &Schema) -> bool {
    is_object(schema)
        && !schema.nullable
        && schema.reference.is_none()
        && schema.values.is_empty()
        && ["const", "allOf", "anyOf", "oneOf"]
            .iter()
            .all(|key| !schema.other.contains_key(*key))
}

fn named_enum(schema: &Schema) -> bool {
    !schema.values.is_empty()
        && !schema.nullable
        && matches!(
            schema.kind.as_deref(),
            Some("string" | "integer" | "number")
        )
        && schema
            .values
            .iter()
            .all(|value| value.is_string() || value.is_number())
}

fn enum_members(schema: &Schema) -> Result<Vec<EnumValue>> {
    let explicit_names = ["x-enum-varnames", "x-enum-names", "x-extensible-enum"]
        .iter()
        .find_map(|key| schema.other.get(*key).and_then(Value::as_array));
    let mut allocated = BTreeSet::new();
    let mut members = Vec::new();
    for (index, value) in schema.values.iter().enumerate() {
        let text = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        let mut name = explicit_names
            .and_then(|names| names.get(index))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| enum_member_name(&text));
        let base = name.clone();
        let mut suffix = 2;
        while !allocated.insert(name.clone()) {
            name = format!("{base}_{suffix}");
            suffix += 1;
        }
        ensure!(!name.is_empty(), "empty enum member name");
        let value = if schema.kind.as_deref() == Some("string") {
            Value::String(text)
        } else {
            value.clone()
        };
        members.push(EnumValue { name, value });
    }
    Ok(members)
}

fn enum_member_name(value: &str) -> String {
    let mut name = String::new();
    for part in value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
    {
        name.push(char::from(part.as_bytes()[0]).to_ascii_uppercase());
        name.push_str(&part[1..]);
    }
    if name.is_empty() {
        return "Empty".into();
    }
    if name.as_bytes()[0].is_ascii_digit() {
        name.insert(0, '_');
    }
    name
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
        let types =
            SchemaTypes::new(&schemas, "I", "", "IQuivraEvent", false, false, false).unwrap();
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
        let types =
            SchemaTypes::new(&schemas, "I", "", "IQuivraEvent", false, false, false).unwrap();
        assert_eq!(types.models().unwrap()[0].name(), "IWidget");
        schemas.insert("Widget".into(), schema(json!({"type":"object"})));
        let error = SchemaTypes::new(&schemas, "I", "", "IQuivraEvent", false, false, false)
            .err()
            .unwrap();
        assert!(error.to_string().contains("schema name collision"));
    }

    #[test]
    fn preserves_explicit_nullable_wrappers_when_enabled() {
        let schemas = BTreeMap::from([(
            "Target".into(),
            schema(json!({
                "type":"object",
                "properties":{"name":{"type":"string"}}
            })),
        )]);
        let types =
            SchemaTypes::new(&schemas, "I", "", "IQuivraEvent", true, false, false).unwrap();
        let composed = schema(json!({
            "type":"object", "nullable":true, "allOf":[{"$ref":"#/components/schemas/Target"}]
        }));
        let mut imports = BTreeSet::new();
        assert_eq!(
            types.expression(&composed, &mut imports).unwrap(),
            "(ITarget) | null"
        );
        assert_eq!(imports.iter().next().unwrap().name, "ITarget");
        let literal = schema(json!({"type":"string","enum":["on"],"nullable":true}));
        assert_eq!(
            types.expression(&literal, &mut imports).unwrap(),
            r#"("on") & (string) | null"#
        );
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
            SchemaTypes::new(&schemas, "", "", "QuivraEvent", false, false, false)
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
        let error = SchemaTypes::new(&schemas, "", "", "QuivraEvent", false, false, false)
            .err()
            .unwrap();
        assert!(error.to_string().contains("unguarded recursive type alias"));
    }
}
