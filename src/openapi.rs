use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
pub struct Api {
    openapi: String,
    pub info: Info,
    #[serde(default)]
    pub components: Components,
    pub paths: BTreeMap<String, PathItem>,
    #[serde(default)]
    security: Vec<BTreeMap<String, Value>>,
}

#[derive(Deserialize)]
pub struct Info {
    pub title: String,
}

#[derive(Default, Deserialize)]
pub struct Components {
    #[serde(default)]
    pub schemas: BTreeMap<String, Schema>,
}

#[derive(Deserialize)]
pub struct PathItem {
    #[serde(default)]
    parameters: Vec<Parameter>,
    #[serde(flatten)]
    fields: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    pub summary: Option<String>,
    #[serde(default)]
    parameters: Vec<Parameter>,
    pub request_body: Option<RequestBody>,
    pub responses: BTreeMap<String, Response>,
    security: Option<Vec<BTreeMap<String, Value>>>,
}

#[derive(Clone, Deserialize)]
pub struct Parameter {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
    #[serde(default)]
    pub required: bool,
    pub schema: Schema,
    pub style: Option<String>,
}

#[derive(Deserialize)]
pub struct RequestBody {
    #[serde(default)]
    pub required: bool,
    pub content: BTreeMap<String, Media>,
}

#[derive(Deserialize)]
pub struct Response {
    #[serde(default)]
    pub content: BTreeMap<String, Media>,
    #[serde(rename = "$ref")]
    reference: Option<String>,
}

#[derive(Deserialize)]
pub struct Media {
    pub schema: Schema,
}

#[derive(Clone, Deserialize)]
pub struct Schema {
    #[serde(rename = "$ref")]
    pub reference: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(rename = "enum", default)]
    pub values: Vec<Value>,
    #[serde(default)]
    pub properties: BTreeMap<String, Schema>,
    #[serde(default)]
    pub required: BTreeSet<String>,
    #[serde(default)]
    pub nullable: bool,
    pub items: Option<Box<Schema>>,
    #[serde(flatten)]
    pub other: BTreeMap<String, Value>,
}

pub struct Endpoint<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub operation: Operation,
    pub parameters: Vec<Parameter>,
}

pub fn parse(document: &str) -> Result<Api> {
    let api: Api = serde_yaml_ng::from_str(document)?;
    let patch = api.openapi.strip_prefix("3.0.");
    ensure!(
        patch.is_some_and(|patch| !patch.is_empty() && patch.bytes().all(|c| c.is_ascii_digit())),
        "expected OpenAPI 3.0.x, got {}",
        api.openapi
    );
    Ok(api)
}

impl Api {
    pub fn endpoints(&self) -> Result<Vec<Endpoint<'_>>> {
        let mut endpoints = Vec::new();
        let mut operation_ids = BTreeSet::new();

        for (path, item) in &self.paths {
            if path.starts_with("x-") {
                continue;
            }
            ensure!(
                path.starts_with('/')
                    && !path.starts_with("//")
                    && !path.contains(['?', '#', '\\']),
                "unsupported API path {path:?}"
            );
            ensure!(
                !item.fields.contains_key("$ref"),
                "{path}: path references are unsupported"
            );
            for (method, value) in &item.fields {
                if !matches!(
                    method.as_str(),
                    "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"
                ) {
                    continue;
                }
                let label = format!("{} {path}", method.to_ascii_uppercase());
                let operation: Operation =
                    serde_json::from_value(value.clone()).with_context(|| label.clone())?;
                ensure!(
                    operation_ids.insert(operation.operation_id.clone()),
                    "{label}: duplicate operationId {}",
                    operation.operation_id
                );
                let security = operation.security.as_ref().unwrap_or(&self.security);
                ensure!(
                    security.iter().all(BTreeMap::is_empty),
                    "{label}: authentication is unsupported"
                );
                let mut parameters = collect_parameters(&item.parameters)
                    .with_context(|| format!("{path} parameters"))?;
                parameters.extend(
                    collect_parameters(&operation.parameters).with_context(|| label.clone())?,
                );
                let parameters = parameters.into_values().collect();
                endpoints.push(Endpoint {
                    method,
                    path,
                    operation,
                    parameters,
                });
            }
        }

        ensure!(!endpoints.is_empty(), "the API has no operations");
        Ok(endpoints)
    }
}

fn collect_parameters(parameters: &[Parameter]) -> Result<BTreeMap<(&str, &str), Parameter>> {
    let mut unique = BTreeMap::new();
    for parameter in parameters {
        let key = (parameter.location.as_str(), parameter.name.as_str());
        ensure!(
            unique.insert(key, parameter.clone()).is_none(),
            "duplicate {} parameter {:?}",
            parameter.location,
            parameter.name
        );
    }
    Ok(unique)
}

impl Operation {
    pub fn success_schema(&self) -> Result<Option<&Schema>> {
        let mut successes = self.responses.iter().filter(|(code, _)| {
            code.parse::<u16>()
                .is_ok_and(|code| (200..300).contains(&code))
                || code.as_str() == "2XX"
        });
        let (code, response) = successes.next().context("a success response is required")?;
        ensure!(
            successes.next().is_none(),
            "multiple success responses are unsupported"
        );
        ensure!(
            response.reference.is_none(),
            "response references are unsupported"
        );
        if response.content.is_empty() {
            return Ok(None);
        }
        if code == "204" || code == "205" {
            bail!("HTTP {code} cannot carry a response body");
        }
        Ok(Some(json_schema(&response.content)?))
    }
}

pub fn json_schema(content: &BTreeMap<String, Media>) -> Result<&Schema> {
    ensure!(
        content.len() == 1,
        "expected a single application/json media type"
    );
    Ok(&content
        .get("application/json")
        .context("only application/json is supported")?
        .schema)
}
