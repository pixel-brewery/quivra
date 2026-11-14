use std::collections::{BTreeMap, BTreeSet};

use anyhow::{Context, Result, bail, ensure};
use serde::Serialize;
use serde_json::Value;

use super::schemas::{Field, ModelImport, SchemaTypes};
use crate::openapi::{Api, ApiKeyLocation, Endpoint, Media, Response, SecurityScheme};

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
    header_parameters: Vec<Field>,
    parameters: Vec<ClientParameter>,
    body_type: Option<String>,
    body_optional: bool,
    response_type: String,
    responses: Vec<ClientResponse>,
    all_responses: Vec<ResponseSummary>,
    variants: Vec<ClientVariant>,
    path_expression: String,
    success_status: u16,
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
    variable: String,
    style: Option<String>,
    explode: Option<bool>,
    allow_reserved: bool,
    #[serde(flatten)]
    field: Field,
}

#[derive(Clone, Serialize)]
struct ResponseSummary {
    status: String,
    description: Option<String>,
    media_types: Vec<String>,
    extensions: BTreeMap<String, Value>,
}

#[derive(Clone, Serialize)]
struct ClientVariant {
    name: String,
    request_body: Option<ClientRequest>,
    response: Option<ClientResponse>,
}

#[derive(Clone, Serialize)]
struct ClientRequest {
    media_type: String,
    #[serde(rename = "type")]
    type_expression: String,
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
    broad_http: bool,
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
                broad_http,
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
    broad_http: bool,
) -> Result<ClientOperation<'a>> {
    let operation = &endpoint.operation;
    let mut imports = BTreeSet::new();
    let mut path_parameters = Vec::new();
    let mut query_parameters = Vec::new();
    let mut header_parameters = Vec::new();
    let mut parameters = Vec::new();
    for parameter in &endpoint.parameters {
        if exclude_deprecated_operations && parameter.deprecated && parameter.location != "path" {
            continue;
        }
        let expected_style = match parameter.location.as_str() {
            "path" => "simple",
            "query" => "form",
            "header" if broad_http => "simple",
            location => bail!("unsupported {location} parameter {:?}", parameter.name),
        };
        ensure!(
            broad_http
                || (parameter
                    .style
                    .as_deref()
                    .is_none_or(|style| style == expected_style)
                    && !parameter.allow_reserved),
            "unsupported serialization options for parameter {:?}",
            parameter.name
        );
        ensure!(
            broad_http || types.is_scalar(&parameter.schema),
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
            variable: parameter_variable(&parameter.name),
            style: parameter.style.clone(),
            explode: parameter.explode,
            allow_reserved: parameter.allow_reserved,
            field: field.clone(),
        });
        if parameter.location == "path" {
            ensure!(
                parameter.required,
                "path parameter {:?} must be required",
                field.name
            );
            path_parameters.push(field);
        } else if parameter.location == "header" {
            header_parameters.push(field);
        } else {
            query_parameters.push(field);
        }
    }
    path_parameters.sort_by(|left, right| left.name.cmp(&right.name));
    query_parameters.sort_by(|left, right| left.name.cmp(&right.name));
    check_path_parameters(endpoint.path, &path_parameters)?;

    let bodies = request_bodies(endpoint, types, &mut imports, broad_http)?;
    let body_type = bodies.first().map(|body| body.type_expression.clone());
    let responses = responses(endpoint, types, event_type, broad_http)?;
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
            media_types: {
                let media_types = response.content.iter().map(|(media, _)| media.clone());
                if broad_http {
                    media_types.collect()
                } else {
                    media_types.collect::<BTreeSet<_>>().into_iter().collect()
                }
            },
            extensions: response.extensions(),
        })
        .collect();
    let success_status = responses
        .iter()
        .find_map(|response| response.status)
        .unwrap_or(200);
    let extensions = operation.extensions();
    let variants = if broad_http {
        let method_name = extensions
            .get("x-operation-name")
            .and_then(Value::as_str)
            .unwrap_or(&operation.operation_id);
        operation_variants(method_name, &bodies, &responses)
    } else {
        Vec::new()
    };
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
    let path_expression = path_expression(endpoint.path, &parameters)?;
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
        header_parameters,
        parameters,
        body_type,
        body_optional: operation
            .request_body
            .as_ref()
            .is_some_and(|body| !body.required),
        response_type,
        responses,
        all_responses,
        variants,
        path_expression,
        success_status,
        accept,
        security,
        summary: operation.summary.clone(),
        extensions,
    })
}

fn request_bodies(
    endpoint: &Endpoint<'_>,
    types: &SchemaTypes<'_>,
    imports: &mut BTreeSet<ModelImport>,
    broad_http: bool,
) -> Result<Vec<ClientRequest>> {
    let Some(body) = &endpoint.operation.request_body else {
        return Ok(Vec::new());
    };
    ensure!(
        broad_http || !matches!(endpoint.method, "get" | "head"),
        "{} request bodies are unsupported",
        endpoint.method
    );
    if !broad_http {
        let schema = crate::openapi::json_schema(&body.content)?;
        return Ok(vec![ClientRequest {
            media_type: "application/json".into(),
            type_expression: types.expression(schema, imports)?,
        }]);
    }
    ensure!(!body.content.is_empty(), "request body has no media types");
    body.content
        .iter()
        .map(|(media_type, media)| {
            let type_expression = media
                .schema
                .as_ref()
                .map(|schema| types.expression_for_multipart(schema, imports))
                .transpose()?
                .unwrap_or_else(|| "unknown".into());
            Ok(ClientRequest {
                media_type: media_type.clone(),
                type_expression,
            })
        })
        .collect()
}

fn operation_variants(
    name: &str,
    bodies: &[ClientRequest],
    responses: &[ClientResponse],
) -> Vec<ClientVariant> {
    let bodies: Vec<_> = if bodies.is_empty() {
        vec![None]
    } else {
        bodies.iter().map(Some).collect()
    };
    let first_status = responses.first().map(|response| response.status);
    let mut responses: Vec<_> = responses
        .iter()
        .take_while(|response| Some(response.status) == first_status)
        .map(Some)
        .collect();
    if responses.is_empty() {
        responses.push(None);
    }
    let mut names = BTreeSet::new();
    let mut variants = Vec::new();
    for body in &bodies {
        let mut method = super::identifier(name);
        if bodies.len() > 1
            && let Some(body) = body
        {
            method.push_str(&variant_suffix(&body.media_type));
        }
        for response in &responses {
            let mut name = method.clone();
            if responses.len() > 1
                && let Some(media_type) = response.and_then(|value| value.media_type.as_deref())
            {
                name.push_str(&variant_suffix(media_type));
            }
            if names.insert(name.clone()) {
                variants.push(ClientVariant {
                    name,
                    request_body: body.cloned(),
                    response: response.cloned(),
                });
            }
        }
    }
    variants
}

fn variant_suffix(media_type: &str) -> String {
    let media_type = media_type.strip_suffix("/*").unwrap_or(media_type);
    if matches!(media_type, "*" | "application/octet-stream") {
        return "$Any".into();
    }
    let suffix = media_type.rsplit(['/', '+']).next().unwrap_or(media_type);
    format!("${}", super::type_name(suffix))
}

fn parameter_variable(name: &str) -> String {
    let mut words = name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty());
    let mut variable = words.next().unwrap_or_default().to_owned();
    for word in words {
        variable.push(char::from(word.as_bytes()[0].to_ascii_uppercase()));
        variable.push_str(&word[1..]);
    }
    if variable.as_bytes().first().is_none_or(u8::is_ascii_digit) {
        variable.insert(0, '_');
    }
    variable
}

fn path_expression(path: &str, parameters: &[ClientParameter]) -> Result<String> {
    let mut expression = String::new();
    let mut remaining = path;
    while let Some((literal, placeholder)) = remaining.split_once('{') {
        // The placeholder syntax and names have been validated already.
        let (name, rest) = placeholder
            .split_once('}')
            .context("unclosed path placeholder")?;
        let parameter = parameters
            .iter()
            .find(|parameter| parameter.location == "path" && parameter.field.name == name)
            .with_context(|| format!("missing path parameter {name:?}"))?;
        expression.push_str(&literal.replace('`', "\\`"));
        expression.push_str("${encodeURIComponent(String(params.");
        expression.push_str(&parameter.variable);
        expression.push_str("))}");
        remaining = rest;
    }
    expression.push_str(&remaining.replace('`', "\\`"));
    Ok(expression)
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
    broad_http: bool,
) -> Result<Vec<ClientResponse>> {
    let mut responses = Vec::new();
    for (code, response) in endpoint.operation.success_responses() {
        let status = code.parse::<u16>().ok();
        ensure!(
            code == "2XX" || status.is_some_and(|code| (200..300).contains(&code)),
            "invalid success status {code:?}"
        );
        if response.content.is_empty() {
            responses.push(empty_response(status, response));
            continue;
        }
        ensure!(
            endpoint.method != "head" && !matches!(status, Some(204 | 205)),
            "HTTP {code} cannot carry a response body"
        );
        ensure!(
            broad_http || response.content.len() == 1,
            "HTTP {code}: expected one success media type per status"
        );
        for (media_type, media) in &response.content {
            let mut result = empty_response(status, response);
            project_response(
                &mut result,
                media_type,
                media,
                types,
                event_type,
                broad_http,
            )
            .with_context(|| format!("HTTP {code}"))?;
            responses.push(result);
        }
    }
    responses.sort_by_key(|response| response.status.unwrap_or(u16::MAX));
    Ok(responses)
}

fn empty_response(status: Option<u16>, response: &Response) -> ClientResponse {
    ClientResponse {
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
    }
}

fn project_response(
    result: &mut ClientResponse,
    media_type: &str,
    media: &Media,
    types: &SchemaTypes<'_>,
    event_type: &str,
    broad_http: bool,
) -> Result<()> {
    result.media_type = Some(media_type.into());
    result.kind = match media_type {
        "text/event-stream" => "sse",
        media_type if is_json(media_type) => "json",
        "*/*" if broad_http => "json",
        media_type if broad_http && media_type.starts_with("text/") => "text",
        _ if broad_http => "blob",
        _ => bail!("unsupported success media type {media_type:?}"),
    };
    if let Some(schema) = &media.schema {
        result.wire_schema_type = schema.kind.clone();
        result.schema_name = types
            .reference_import(schema)
            .map(|reference| reference.name.clone());
        result.envelope_property = types.envelope_property(schema);
        // A transport can supply a stricter type for an opaque Swagger event schema.
        let wire_type = if result.kind == "sse" && schema.kind.as_deref() == Some("Object") {
            "unknown".into()
        } else if broad_http {
            types.expression_for_multipart(schema, &mut result.imports)?
        } else {
            types.expression(schema, &mut result.imports)?
        };
        result.wire_type = Some(wire_type);
    }
    result.type_expression = match result.kind {
        "sse" => format!("globalThis.AsyncIterable<{event_type}>"),
        "blob" => "Blob".into(),
        "text" => result.wire_type.clone().unwrap_or_else(|| "string".into()),
        _ if broad_http => result.wire_type.clone().unwrap_or_else(|| "unknown".into()),
        _ => result
            .wire_type
            .clone()
            .context("JSON response requires a schema")?,
    };
    Ok(())
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

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use crate::{openapi, typescript};

    #[test]
    fn broad_projection_preserves_media_variants_and_transport_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let spec = directory.path().join("api.json");
        fs::write(
            &spec,
            r##"{
                "openapi": "3.0.3",
                "info": {"title": "Uploads"},
                "components": {"schemas": {"Upload": {"type": "object"}}},
                "paths": {
                    "/files/{fileId}": {"post": {
                        "operationId": "postFile",
                        "x-operation-name": "upload",
                        "parameters": [
                            {"name": "fileId", "in": "path", "required": true, "schema": {"type": "string"}},
                            {"name": "X-Checksum", "in": "header", "schema": {"type": "string"}},
                            {"name": "tag", "in": "query", "explode": false, "schema": {"type": "array", "items": {"type": "string"}}}
                        ],
                        "requestBody": {"required": true, "content": {
                            "multipart/form-data": {"schema": {"type": "object", "required": ["file"], "properties": {
                                "file": {"type": "string", "format": "binary"}
                            }}},
                            "application/json": {"schema": {"type": "string"}}
                        }},
                        "responses": {
                            "202": {"description": "Accepted", "content": {
                                "application/vnd.example+json": {"schema": {"$ref": "#/components/schemas/Upload", "nullable": true}},
                                "application/json": {"schema": {"type": "boolean"}},
                                "application/pdf": {"schema": {"type": "string", "format": "binary"}}
                            }},
                            "204": {"description": "No content"},
                            "409": {"description": "Conflict", "x-error-codes": ["EXISTS"]}
                        }
                    }}
                }
            }"##,
        )
        .unwrap();
        let api = openapi::load(&spec, None).unwrap();
        let options = Default::default();
        assert!(typescript::context(&api, &options, &Default::default()).is_err());
        let projection = typescript::ProjectionOptions {
            broad_http: true,
            preserve_nullable_annotations: true,
            ..Default::default()
        };
        let context = typescript::context(&api, &options, &projection).unwrap();
        let value = serde_json::to_value(context).unwrap();
        let operation = &value["operations"][0];
        assert_eq!(operation["parameters"][1]["variable"], "XChecksum");
        assert_eq!(operation["parameters"][2]["explode"], false);
        assert_eq!(operation["success_status"], 202);
        assert_eq!(
            operation["path_expression"],
            "/files/${encodeURIComponent(String(params.fileId))}"
        );
        assert_eq!(
            operation["all_responses"][2]["extensions"]["x-error-codes"],
            json!(["EXISTS"])
        );
        assert_eq!(operation["responses"][2]["kind"], "blob");
        let variants = operation["variants"].as_array().unwrap();
        assert_eq!(variants.len(), 4);
        assert_eq!(variants[0]["name"], "upload$FormData$Json");
        assert_eq!(
            variants[0]["response"]["media_type"],
            "application/vnd.example+json"
        );
        assert_eq!(variants[0]["response"]["wire_type"], "Upload | null");
        assert!(
            variants[0]["request_body"]["type"]
                .as_str()
                .unwrap()
                .contains("Blob")
        );
    }
}
