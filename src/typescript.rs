use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use crate::openapi::{Api, Endpoint, Schema, json_schema};

#[derive(Serialize)]
pub struct ContextData<'a> {
    api: ApiInfo<'a>,
    models: Vec<Model<'a>>,
    operations: Vec<ClientOperation<'a>>,
    options: &'a BTreeMap<String, Value>,
}

#[derive(Serialize)]
struct ApiInfo<'a> {
    title: &'a str,
}

#[derive(Serialize)]
struct Model<'a> {
    name: &'a str,
    fields: Vec<Field>,
}

#[derive(Serialize)]
struct Field {
    name: String,
    #[serde(rename = "type")]
    type_expression: String,
    optional: bool,
}

#[derive(Serialize)]
struct ClientOperation<'a> {
    id: String,
    method: String,
    path: &'a str,
    path_parameters: Vec<Field>,
    query_parameters: Vec<Field>,
    body_type: Option<String>,
    response_type: String,
    summary: Option<String>,
}

pub fn context<'a>(api: &'a Api, options: &'a BTreeMap<String, Value>) -> Result<ContextData<'a>> {
    let schemas = &api.components.schemas;
    let mut models = Vec::new();
    for (name, schema) in schemas {
        ensure!(valid_identifier(name), "unsupported model name {name:?}");
        ensure!(
            schema.kind.as_deref() == Some("object")
                && schema.reference.is_none()
                && schema.values.is_empty()
                && !schema.nullable,
            "component {name} must be a non-nullable object schema"
        );
        let fields = object_fields(schema, schemas).with_context(|| format!("schema {name}"))?;
        models.push(Model { name, fields });
    }
    let operations = api
        .endpoints()?
        .into_iter()
        .map(|endpoint| {
            let label = format!("{} {}", endpoint.method.to_ascii_uppercase(), endpoint.path);
            build_operation(endpoint, schemas).with_context(|| label)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(ContextData {
        api: ApiInfo {
            title: &api.info.title,
        },
        models,
        operations,
        options,
    })
}

fn build_operation<'a>(
    endpoint: Endpoint<'a>,
    schemas: &BTreeMap<String, Schema>,
) -> Result<ClientOperation<'a>> {
    let Endpoint {
        method,
        path,
        operation,
        parameters,
    } = endpoint;
    ensure!(
        valid_identifier(&operation.operation_id),
        "unsupported operationId {:?}",
        operation.operation_id
    );
    let mut path_parameters = Vec::new();
    let mut query_parameters = Vec::new();
    for parameter in parameters {
        let expected_style = match parameter.location.as_str() {
            "path" => "simple",
            "query" => "form",
            location => bail!("unsupported {location} parameter {:?}", parameter.name),
        };
        ensure!(
            parameter
                .style
                .as_deref()
                .is_none_or(|style| style == expected_style),
            "unsupported style for parameter {:?}",
            parameter.name
        );
        let schema = &parameter.schema;
        ensure!(
            schema.reference.is_none()
                && !schema.nullable
                && matches!(
                    schema.kind.as_deref(),
                    Some("string" | "integer" | "number" | "boolean")
                ),
            "parameter {:?} must be a non-nullable scalar",
            parameter.name
        );
        let field = Field {
            name: parameter.name,
            type_expression: type_expression(schema, schemas)?,
            optional: !parameter.required,
        };
        if expected_style == "simple" {
            ensure!(
                parameter.required,
                "path parameter {:?} must be required",
                field.name
            );
            path_parameters.push(field);
        } else {
            query_parameters.push(field);
        }
    }
    let mut remaining = path;
    let mut placeholders = BTreeSet::new();
    while let Some((before, opening)) = remaining.split_once('{') {
        let (name, after) = opening
            .split_once('}')
            .context("unclosed path placeholder")?;
        ensure!(
            !before.contains('}') && !name.contains('{') && !name.is_empty(),
            "invalid path placeholder"
        );
        placeholders.insert(name);
        remaining = after;
    }
    ensure!(!remaining.contains('}'), "invalid path placeholder");
    let declared = path_parameters
        .iter()
        .map(|field| field.name.as_str())
        .collect();
    ensure!(
        placeholders == declared,
        "path placeholders must match the declared path parameters"
    );

    let body_type = operation
        .request_body
        .as_ref()
        .map(|body| {
            ensure!(body.required, "optional request bodies are unsupported");
            ensure!(
                method != "get" && method != "head",
                "{method} request bodies are unsupported"
            );
            type_expression(json_schema(&body.content)?, schemas)
        })
        .transpose()?;
    let response_type = match operation.success_schema()? {
        Some(schema) => type_expression(schema, schemas)?,
        None => "void".into(),
    };
    Ok(ClientOperation {
        id: operation.operation_id,
        method: method.to_ascii_uppercase(),
        path,
        path_parameters,
        query_parameters,
        body_type,
        response_type,
        summary: operation.summary,
    })
}

fn object_fields(schema: &Schema, schemas: &BTreeMap<String, Schema>) -> Result<Vec<Field>> {
    check_shape(schema)?;
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
                type_expression: type_expression(field, schemas)
                    .with_context(|| format!("property {name:?}"))?,
                optional: !schema.required.contains(name),
            })
        })
        .collect()
}

fn type_expression(schema: &Schema, schemas: &BTreeMap<String, Schema>) -> Result<String> {
    check_shape(schema)?;
    if let Some(reference) = &schema.reference {
        let name = reference
            .strip_prefix("#/components/schemas/")
            .with_context(|| format!("unsupported schema reference {reference:?}"))?;
        ensure!(
            schemas.contains_key(name),
            "unknown schema reference {reference:?}"
        );
        return Ok(name.into());
    }

    let expression = match schema.kind.as_deref() {
        Some("string" | "integer" | "number" | "boolean") if !schema.values.is_empty() => {
            let kind = schema.kind.as_deref().unwrap_or_default();
            let literals = schema
                .values
                .iter()
                .map(|value| {
                    let compatible = match kind {
                        "string" => value.is_string(),
                        "integer" => value.is_i64() || value.is_u64(),
                        "number" => value.is_number(),
                        "boolean" => value.is_boolean(),
                        _ => false,
                    };
                    ensure!(
                        compatible || (schema.nullable && value.is_null()),
                        "invalid enum literal {value}"
                    );
                    Ok(serde_json::to_string(value)?)
                })
                .collect::<Result<Vec<_>>>()?;
            return Ok(literals.join(" | "));
        }
        Some("string") => "string".into(),
        Some("integer" | "number") => "number".into(),
        Some("boolean") => "boolean".into(),
        Some("array") => {
            let items = schema.items.as_ref().context("array requires items")?;
            format!("Array<{}>", type_expression(items, schemas)?)
        }
        Some("object") => {
            let fields = object_fields(schema, schemas)?;
            let entries = fields
                .iter()
                .map(|field| {
                    let name = serde_json::to_string(&field.name)?;
                    let optional = if field.optional { "?" } else { "" };
                    Ok(format!("{name}{optional}: {}", field.type_expression))
                })
                .collect::<Result<Vec<_>>>()?;
            format!("{{ {} }}", entries.join("; "))
        }
        _ => bail!("unsupported schema type {:?}", schema.kind),
    };
    if schema.nullable {
        Ok(format!("{expression} | null"))
    } else {
        Ok(expression)
    }
}

fn check_shape(schema: &Schema) -> Result<()> {
    for keyword in ["allOf", "oneOf", "anyOf", "not", "discriminator"] {
        ensure!(
            !schema.other.contains_key(keyword),
            "unsupported schema keyword {keyword}"
        );
    }
    ensure!(
        schema
            .other
            .get("additionalProperties")
            .is_none_or(|value| value == &Value::Bool(false)),
        "explicit additionalProperties other than false is unsupported"
    );
    ensure!(
        schema.values.is_empty()
            || matches!(
                schema.kind.as_deref(),
                Some("string" | "integer" | "number" | "boolean")
            ),
        "only scalar enums are supported"
    );
    Ok(())
}

fn valid_identifier(name: &str) -> bool {
    let mut characters = name.chars();
    let starts =
        |character: char| character.is_ascii_alphabetic() || matches!(character, '_' | '$');
    characters.next().is_some_and(starts)
        && characters.all(|character| starts(character) || character.is_ascii_digit())
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
        )
}
