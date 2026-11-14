mod document;
mod references;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::Value;

pub struct Api {
    pub info: Info,
    pub components: Components,
    paths: BTreeMap<String, PathItem>,
    security: SecurityRequirements,
}

#[derive(Deserialize)]
pub struct Info {
    pub title: String,
}

#[derive(Default, Deserialize)]
pub struct Components {
    #[serde(default)]
    pub schemas: BTreeMap<String, Schema>,
    #[serde(default, rename = "securitySchemes")]
    pub security_schemes: BTreeMap<String, SecurityScheme>,
}

pub enum SecurityScheme {
    Bearer,
    ApiKey {
        name: String,
        location: ApiKeyLocation,
    },
    Unsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyLocation {
    Header,
    Query,
    Cookie,
}

#[derive(Deserialize)]
struct RawSecurityScheme {
    #[serde(rename = "type")]
    kind: String,
    scheme: Option<String>,
    name: Option<String>,
    #[serde(rename = "in")]
    location: Option<ApiKeyLocation>,
}

impl<'de> Deserialize<'de> for SecurityScheme {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        use serde::de::Error;

        let raw = RawSecurityScheme::deserialize(deserializer)?;
        match raw.kind.as_str() {
            "http"
                if raw
                    .scheme
                    .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer")) =>
            {
                Ok(Self::Bearer)
            }
            "apiKey" => {
                let name = raw
                    .name
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| D::Error::missing_field("name"))?;
                let location = raw.location.ok_or_else(|| D::Error::missing_field("in"))?;
                Ok(Self::ApiKey { name, location })
            }
            _ => Ok(Self::Unsupported),
        }
    }
}

pub type SecurityRequirements = Vec<BTreeMap<String, Vec<String>>>;

#[derive(Clone, Deserialize)]
struct PathItem {
    #[serde(default)]
    parameters: Vec<Parameter>,
    #[serde(flatten)]
    methods: BTreeMap<String, Value>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation_id: String,
    pub summary: Option<String>,
    #[serde(default)]
    parameters: Vec<Parameter>,
    pub request_body: Option<RequestBody>,
    pub responses: BTreeMap<String, Response>,
    security: Option<SecurityRequirements>,
    #[serde(flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Parameter {
    pub name: String,
    #[serde(rename = "in")]
    pub location: String,
    #[serde(default)]
    pub required: bool,
    pub schema: Schema,
    pub style: Option<String>,
    #[serde(default)]
    pub allow_reserved: bool,
}

#[derive(Clone, Deserialize)]
pub struct RequestBody {
    #[serde(default)]
    pub required: bool,
    pub content: BTreeMap<String, Media>,
}

#[derive(Clone, Deserialize)]
pub struct Response {
    #[serde(default)]
    pub content: BTreeMap<String, Media>,
}

#[derive(Clone, Deserialize)]
pub struct Media {
    pub schema: Option<Schema>,
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
    pub security: SecurityRequirements,
}

pub fn load(path: &Path, reference_root: Option<&Path>) -> Result<Api> {
    document::load(path, reference_root)
}

impl Api {
    pub fn endpoints(&self) -> Result<Vec<Endpoint<'_>>> {
        let mut endpoints = Vec::new();
        let mut operation_ids = BTreeSet::new();

        for (path, item) in &self.paths {
            ensure!(
                path.starts_with('/')
                    && !path.starts_with("//")
                    && !path.contains(['?', '#', '\\'])
                    && !path.chars().any(char::is_control),
                "unsupported API path {path:?}"
            );
            let inherited_parameters = collect_parameters(&item.parameters)
                .with_context(|| format!("{path} parameters"))?;
            for (method, value) in &item.methods {
                if !is_method(method) {
                    continue;
                }
                let label = format!("{} {path}", method.to_ascii_uppercase());
                let operation: Operation =
                    serde_json::from_value(value.clone()).with_context(|| label.clone())?;
                ensure!(
                    !operation.operation_id.is_empty(),
                    "{label}: operationId must not be empty"
                );
                ensure!(
                    operation_ids.insert(operation.operation_id.clone()),
                    "{label}: duplicate operationId {}",
                    operation.operation_id
                );
                let security = operation
                    .security
                    .as_ref()
                    .unwrap_or(&self.security)
                    .clone();
                for scheme in security.iter().flat_map(BTreeMap::keys) {
                    ensure!(
                        self.components.security_schemes.contains_key(scheme),
                        "{label}: unknown security scheme {scheme:?}"
                    );
                }
                let mut parameters = inherited_parameters.clone();
                parameters.extend(
                    collect_parameters(&operation.parameters).with_context(|| label.clone())?,
                );
                endpoints.push(Endpoint {
                    method,
                    path,
                    operation,
                    security,
                    parameters: parameters.into_values().collect(),
                });
            }
        }

        ensure!(!endpoints.is_empty(), "the API has no operations");
        Ok(endpoints)
    }
}

fn collect_parameters(parameters: &[Parameter]) -> Result<BTreeMap<(String, String), Parameter>> {
    let mut unique = BTreeMap::new();
    for parameter in parameters {
        ensure!(
            !parameter.name.is_empty(),
            "parameter name must not be empty"
        );
        let comparison_name = if parameter.location == "header" {
            parameter.name.to_ascii_lowercase()
        } else {
            parameter.name.clone()
        };
        let key = (parameter.location.clone(), comparison_name);
        ensure!(
            unique.insert(key, parameter.clone()).is_none(),
            "duplicate {} parameter {:?}",
            parameter.location,
            parameter.name
        );
    }
    Ok(unique)
}

fn is_method(method: &str) -> bool {
    matches!(
        method,
        "get" | "put" | "post" | "delete" | "options" | "head" | "patch" | "trace"
    )
}

impl Operation {
    pub fn extensions(&self) -> BTreeMap<String, Value> {
        self.extra
            .iter()
            .filter(|(key, _)| key.starts_with("x-"))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    pub fn success_responses(&self) -> Vec<(&str, &Response)> {
        self.responses
            .iter()
            .filter(|(code, _)| code.as_bytes().first() == Some(&b'2'))
            .map(|(code, response)| (code.as_str(), response))
            .collect()
    }
}

pub fn json_schema(content: &BTreeMap<String, Media>) -> Result<&Schema> {
    ensure!(
        content.len() == 1,
        "expected a single application/json media type"
    );
    content
        .get("application/json")
        .context("only application/json is supported")?
        .schema
        .as_ref()
        .context("application/json requires a schema")
}
