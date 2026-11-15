use schemars::{Schema, SchemaGenerator, generate::SchemaSettings, json_schema};
use serde_json::json;

use super::{Document, Manifest, PROFILE_VERSION};

pub(super) const RELATIVE_PATH: &str =
    r"^(?:[A-Za-z0-9_.$-]*[A-Za-z0-9_$-]/)*[A-Za-z0-9_.$-]*[A-Za-z0-9_$-]$";

pub fn profile_schema() -> Schema {
    SchemaSettings::draft07()
        .into_generator()
        .into_root_schema_for::<Manifest>()
}

pub fn batch_schema() -> Schema {
    let mut schema = SchemaSettings::draft07()
        .into_generator()
        .into_root_schema_for::<Vec<Document>>();
    schema.insert("title".into(), json!("Quivra generation batch"));
    schema.insert("minItems".into(), json!(1));
    schema
}

pub(super) fn profile_version(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "integer", "const": PROFILE_VERSION })
}

pub(super) fn file_map(schema: &mut Schema) {
    schema.insert(
        "propertyNames".into(),
        json!({ "type": "string", "pattern": RELATIVE_PATH }),
    );
    if let Some(template) = schema
        .get_mut("additionalProperties")
        .and_then(serde_json::Value::as_object_mut)
    {
        template.insert("pattern".into(), json!(RELATIVE_PATH));
    }
}

pub(super) fn require_output(schema: &mut Schema) {
    schema.insert(
        "anyOf".into(),
        json!([
            {
                "properties": { "files": { "type": "object", "minProperties": 1 } },
                "required": ["files"]
            },
            {
                "properties": { "modelFiles": { "type": "array", "minItems": 1 } },
                "required": ["modelFiles"]
            },
            {
                "properties": { "serviceFiles": { "type": "array", "minItems": 1 } },
                "required": ["serviceFiles"]
            }
        ]),
    );
}
