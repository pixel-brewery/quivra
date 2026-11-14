use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use super::schemas::{Field, ModelImport, SchemaTypes};
use crate::openapi::{Api, ApiKeyLocation, Endpoint, SecurityScheme};

#[derive(Clone, Serialize)]
pub(super) struct ClientOperation<'a> {
    id: String,
    raw_id: String,
    pub(super) tags: Vec<String>,
    pub(super) deprecated: bool,
    description: Option<String>,
    imports: BTreeSet<ModelImport>,
    method: String,
    path: &'a str,
    path_parameters: Vec<Field>,
    query_parameters: Vec<Field>,
    parameters: Vec<ClientParameter>,
    body_type: Option<String>,
    body_optional: bool,
    response_type: String,
    responses: Vec<ClientResponse>,
    all_responses: Vec<ResponseSummary>,
    accept: Option<String>,
    security: Vec<Vec<Credential>>,
    summary: Option<String>,
    extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize)]
struct ClientResponse {
    status: Option<u16>,
    kind: &'static str,
    #[serde(rename = "type")]
    type_expression: String,
    media_type: Option<String>,
    wire_type: Option<String>,
    wire_schema_type: Option<String>,
    schema_name: Option<String>,
    description: Option<String>,
    imports: BTreeSet<ModelImport>,
    envelope_property: Option<String>,
}

#[derive(Clone, Serialize)]
struct ClientParameter {
    location: String,
    #[serde(flatten)]
    field: Field,
}

#[derive(Clone, Serialize)]
struct ResponseSummary {
    status: String,
    description: Option<String>,
    media_types: Vec<String>,
}

#[derive(Clone, Serialize)]
struct Credential {
    name: String,
    kind: &'static str,
    location: &'static str,
    wire_name: String,
}

impl ClientOperation<'_> {
    pub fn imports(&self) -> &BTreeSet<ModelImport> {
        &self.imports
    }

    pub fn model_references(&self) -> impl Iterator<Item = &ModelImport> {
        self.imports
            .iter()
            .chain(self.responses.iter().flat_map(|response| &response.imports))
    }

    pub fn uses_sse(&self) -> bool {
        self.responses.iter().any(|response| response.kind == "sse")
    }
}

pub(super) fn build<'a>(
    api: &'a Api,
    types: &SchemaTypes<'_>,
    event_type: &str,
    exclude_deprecated_operations: bool,
) -> Result<Vec<ClientOperation<'a>>> {
    let endpoints: Vec<_> = api
        .endpoints()?
        .into_iter()
        .filter(|endpoint| !(exclude_deprecated_operations && endpoint.operation.deprecated))
        .collect();
    let ids = super::names(
        endpoints
            .iter()
            .map(|endpoint| &endpoint.operation.operation_id),
        "operation",
    )?;
    endpoints
        .iter()
        .map(|endpoint| {
            let label = format!("{} {}", endpoint.method.to_ascii_uppercase(), endpoint.path);
            let id = ids[endpoint.operation.operation_id.as_str()].clone();
            build_operation(
                endpoint,
                id,
                types,
                event_type,
                &api.components.security_schemes,
                exclude_deprecated_operations,
            )
            .with_context(|| label)
        })
        .collect()
}

fn build_operation<'a>(
    endpoint: &Endpoint<'a>,
    id: String,
    types: &SchemaTypes<'_>,
    event_type: &str,
    schemes: &BTreeMap<String, SecurityScheme>,
    exclude_deprecated_operations: bool,
) -> Result<ClientOperation<'a>> {
    let operation = &endpoint.operation;
    let mut imports = BTreeSet::new();
    let mut path_parameters = Vec::new();
    let mut query_parameters = Vec::new();
    let mut parameters = Vec::new();
    for parameter in &endpoint.parameters {
        if exclude_deprecated_operations && parameter.deprecated && parameter.location != "path" {
            continue;
        }
        let expected_style = match parameter.location.as_str() {
            "path" => "simple",
            "query" => "form",
            location => bail!("unsupported {location} parameter {:?}", parameter.name),
        };
        ensure!(
            parameter
                .style
                .as_deref()
                .is_none_or(|style| style == expected_style)
                && !parameter.allow_reserved,
            "unsupported serialization options for parameter {:?}",
            parameter.name
        );
        ensure!(
            types.is_scalar(&parameter.schema),
            "parameter {:?} must be a non-nullable scalar",
            parameter.name
        );
        let field = Field {
            name: parameter.name.clone(),
            type_expression: types.expression(&parameter.schema, &mut imports)?,
            optional: !parameter.required,
            deprecated: parameter.deprecated,
            description: parameter.description.clone(),
        };
        parameters.push(ClientParameter {
            location: parameter.location.clone(),
            field: field.clone(),
        });
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
    path_parameters.sort_by(|left, right| left.name.cmp(&right.name));
    query_parameters.sort_by(|left, right| left.name.cmp(&right.name));
    check_path_parameters(endpoint.path, &path_parameters)?;

    let body_type = operation
        .request_body
        .as_ref()
        .map(|body| {
            ensure!(
                endpoint.method != "get" && endpoint.method != "head",
                "{} request bodies are unsupported",
                endpoint.method
            );
            types.expression(crate::openapi::json_schema(&body.content)?, &mut imports)
        })
        .transpose()?;
    let responses = responses(endpoint, types, event_type)?;
    for response in &responses {
        if response.kind != "sse" {
            imports.extend(response.imports.iter().cloned());
        }
    }
    let all_responses = operation
        .responses
        .iter()
        .map(|(status, response)| ResponseSummary {
            status: status.clone(),
            description: response.description.clone(),
            media_types: response.content.keys().cloned().collect(),
        })
        .collect();
    let return_types: BTreeSet<_> = responses
        .iter()
        .map(|response| response.type_expression.as_str())
        .collect();
    let mut response_type = return_types
        .into_iter()
        .map(|ty| {
            if ty.contains(" & ") {
                format!("({ty})")
            } else {
                ty.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" | ");
    if response_type.is_empty() {
        response_type = "never".into();
    }
    let media: BTreeSet<_> = responses
        .iter()
        .filter_map(|response| response.media_type.as_deref())
        .collect();
    let accept = (!media.is_empty()).then(|| media.into_iter().collect::<Vec<_>>().join(", "));
    let security = credentials(&endpoint.security, schemes, &query_parameters)?;
    Ok(ClientOperation {
        id,
        raw_id: operation.operation_id.clone(),
        tags: operation.tags.clone(),
        deprecated: operation.deprecated,
        description: operation.description.clone(),
        imports,
        method: endpoint.method.to_ascii_uppercase(),
        path: endpoint.path,
        path_parameters,
        query_parameters,
        parameters,
        body_type,
        body_optional: operation
            .request_body
            .as_ref()
            .is_some_and(|body| !body.required),
        response_type,
        responses,
        all_responses,
        accept,
        security,
        summary: operation.summary.clone(),
        extensions: operation.extensions(),
    })
}

fn check_path_parameters(path: &str, parameters: &[Field]) -> Result<()> {
    ensure!(
        !path.split('/').any(|segment| {
            matches!(
                segment.to_ascii_lowercase().replace("%2e", ".").as_str(),
                "." | ".."
            )
        }),
        "API paths cannot contain dot segments"
    );
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
    let declared = parameters.iter().map(|field| field.name.as_str()).collect();
    ensure!(
        placeholders == declared,
        "path placeholders must match the declared path parameters"
    );
    Ok(())
}

fn responses(
    endpoint: &Endpoint<'_>,
    types: &SchemaTypes<'_>,
    event_type: &str,
) -> Result<Vec<ClientResponse>> {
    let mut responses = Vec::new();
    for (code, response) in endpoint.operation.success_responses() {
        let status = code.parse::<u16>().ok();
        ensure!(
            code == "2XX" || status.is_some_and(|code| (200..300).contains(&code)),
            "invalid success status {code:?}"
        );
        let mut result = ClientResponse {
            status,
            kind: "void",
            type_expression: "void".into(),
            media_type: None,
            wire_type: None,
            wire_schema_type: None,
            schema_name: None,
            description: response.description.clone(),
            imports: BTreeSet::new(),
            envelope_property: None,
        };
        if !response.content.is_empty() {
            ensure!(
                endpoint.method != "head" && !matches!(status, Some(204 | 205)),
                "HTTP {code} cannot carry a response body"
            );
            ensure!(
                response.content.len() == 1,
                "HTTP {code}: expected one success media type per status"
            );
            let (media_type, media) = response
                .content
                .first_key_value()
                .context("response media type missing")?;
            result.media_type = Some(media_type.clone());
            result.kind = match media_type.as_str() {
                "text/event-stream" => "sse",
                media_type if is_json(media_type) => "json",
                _ => bail!("HTTP {code}: unsupported success media type {media_type:?}"),
            };
            if let Some(schema) = &media.schema {
                result.wire_schema_type = schema.kind.clone();
                result.schema_name = types
                    .reference_import(schema)
                    .map(|reference| reference.name.clone());
                result.envelope_property = types.envelope_property(schema);
                // Preserve a conventional Swagger spelling where event payloads were
                // already accepted as opaque because the transport supplies the type.
                let wire_type = if result.kind == "sse" && schema.kind.as_deref() == Some("Object")
                {
                    "unknown".into()
                } else {
                    types.expression(schema, &mut result.imports)?
                };
                result.wire_type = Some(wire_type);
            }
            result.type_expression = match result.kind {
                "sse" => format!("globalThis.AsyncIterable<{event_type}>"),
                _ => result
                    .wire_type
                    .clone()
                    .with_context(|| format!("HTTP {code}: JSON response requires a schema"))?,
            };
        }
        responses.push(result);
    }
    responses.sort_by_key(|response| response.status.unwrap_or(u16::MAX));
    Ok(responses)
}

fn is_json(media_type: &str) -> bool {
    media_type == "application/json"
        || media_type
            .strip_prefix("application/")
            .is_some_and(|subtype| subtype.ends_with("+json"))
}

fn credentials(
    requirements: &[BTreeMap<String, Vec<String>>],
    schemes: &BTreeMap<String, SecurityScheme>,
    query_parameters: &[Field],
) -> Result<Vec<Vec<Credential>>> {
    if requirements.iter().all(BTreeMap::is_empty) {
        return Ok(Vec::new());
    }
    requirements
        .iter()
        .map(|requirement| {
            let mut targets = BTreeSet::new();
            requirement
                .iter()
                .map(|(name, scopes)| {
                    ensure!(
                        scopes.is_empty(),
                        "security scheme {name:?} has unsupported scopes"
                    );
                    let scheme = schemes
                        .get(name)
                        .with_context(|| format!("unknown security scheme {name:?}"))?;
                    let (kind, location, wire_name) = match scheme {
                        SecurityScheme::Bearer => ("bearer", "header", "Authorization"),
                        SecurityScheme::ApiKey {
                            name,
                            location: ApiKeyLocation::Header,
                        } => ("apiKey", "header", name.as_str()),
                        SecurityScheme::ApiKey {
                            name,
                            location: ApiKeyLocation::Query,
                        } => ("apiKey", "query", name.as_str()),
                        _ => bail!("unsupported security scheme {name:?}"),
                    };
                    let target = if location == "header" {
                        ensure!(
                            valid_header_name(wire_name),
                            "invalid credential header name {wire_name:?}"
                        );
                        wire_name.to_ascii_lowercase()
                    } else {
                        ensure!(
                            !wire_name.is_empty(),
                            "credential query name cannot be empty"
                        );
                        ensure!(
                            !query_parameters.iter().any(|field| field.name == wire_name),
                            "credential collides with query parameter {wire_name:?}"
                        );
                        wire_name.to_owned()
                    };
                    if location == "header" {
                        ensure!(
                            !matches!(target.as_str(), "accept" | "content-type"),
                            "credential conflicts with HTTP header {wire_name:?}"
                        );
                    }
                    ensure!(
                        targets.insert((location, target)),
                        "security schemes share the same {location} target {wire_name:?}"
                    );
                    Ok(Credential {
                        name: name.clone(),
                        kind,
                        location,
                        wire_name: wire_name.to_owned(),
                    })
                })
                .collect()
        })
        .collect()
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&byte))
}
