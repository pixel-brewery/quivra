mod output;
mod schema;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use minijinja::{AutoEscape, Environment, UndefinedBehavior};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::typescript::{ContextData, Model, ProjectionOptions, Service, valid_identifier};
pub use output::FilePlan;
pub use schema::{batch_schema, profile_schema};

const PROFILE_VERSION: u32 = 1;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[schemars(title = "Quivra profile", transform = schema::require_output)]
struct Manifest {
    /// Format version of this profile.
    #[schemars(schema_with = "schema::profile_version")]
    version: u32,
    /// Optional editor schema reference.
    #[serde(default, rename = "$schema")]
    _schema: String,
    /// Output paths mapped to template paths relative to this profile.
    #[serde(deserialize_with = "unique_file_map")]
    #[schemars(transform = schema::file_map)]
    files: BTreeMap<String, String>,
    /// Templates for individual TypeScript models, by model kind.
    #[serde(default)]
    model_files: Vec<ModelFiles>,
    /// Templates for individual OpenAPI services.
    #[serde(default)]
    service_files: Vec<ServiceFiles>,
    /// Output paths and templates for files written at the batch root.
    #[serde(default, deserialize_with = "unique_file_map")]
    #[schemars(transform = schema::file_map)]
    batch_files: BTreeMap<String, String>,
    /// Settings for projecting OpenAPI into the template context.
    #[serde(default)]
    typescript: ProjectionOptions,
    /// Project-defined JSON values exposed to templates as options.
    #[serde(default)]
    options: BTreeMap<String, Value>,
}

pub struct Profile {
    root: PathBuf,
    files: BTreeMap<String, String>,
    model_files: Vec<ModelFiles>,
    service_files: Vec<ServiceFiles>,
    batch_files: BTreeMap<String, String>,
    pub typescript: ProjectionOptions,
    pub options: BTreeMap<String, Value>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ServiceFiles {
    #[schemars(regex(pattern = schema::RELATIVE_PATH))]
    directory: String,
    #[schemars(regex(pattern = schema::RELATIVE_PATH))]
    template: String,
    /// Suffix appended to the generated service name.
    #[serde(default)]
    #[schemars(regex(pattern = r"^[A-Za-z0-9_$]*$"))]
    suffix: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ModelFiles {
    kind: ModelKind,
    #[schemars(regex(pattern = schema::RELATIVE_PATH))]
    directory: String,
    #[schemars(regex(pattern = schema::RELATIVE_PATH))]
    template: String,
}

#[derive(Clone, Copy, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "lowercase")]
enum ModelKind {
    Interface,
    Type,
    Enum,
}

pub enum Starter {
    Fetch,
    Transport,
}

#[derive(Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    /// TypeScript namespace for this document in the batch.
    #[schemars(regex(pattern = r"^[A-Za-z_$][A-Za-z0-9_$]*$"))]
    pub namespace: String,
    /// Name of a single output directory below the batch root.
    #[schemars(regex(pattern = r"^[A-Za-z0-9_.$-]*[A-Za-z0-9_$-]$"))]
    pub directory: String,
    /// OpenAPI file path, either absolute or relative to the batch manifest.
    #[serde(skip_serializing)]
    #[schemars(!skip_serializing)]
    pub spec: PathBuf,
}

enum TemplateScope<'a> {
    Document,
    Model(&'a Model),
    Service(&'a Service<'a>),
}

impl Profile {
    pub fn load(path: &Path) -> Result<Self> {
        let path = if path.is_dir() {
            path.join("profile.json")
        } else {
            path.to_owned()
        };
        let path = path
            .canonicalize()
            .with_context(|| format!("resolve {}", path.display()))?;
        let contents = fs::read(&path).with_context(|| format!("read {}", path.display()))?;
        let manifest: Manifest = serde_json::from_slice(&contents)
            .with_context(|| format!("parse {}", path.display()))?;
        ensure!(
            manifest.version == PROFILE_VERSION,
            "unsupported profile version {}",
            manifest.version
        );
        ensure!(
            !(manifest.files.is_empty()
                && manifest.model_files.is_empty()
                && manifest.service_files.is_empty()),
            "profile must declare at least one output file"
        );
        validate_file_rules(&manifest.files)?;
        validate_file_rules(&manifest.batch_files)?;
        let mut kinds = BTreeSet::new();
        for rule in &manifest.model_files {
            ensure!(
                kinds.insert(rule.kind),
                "duplicate modelFiles rule for one model kind"
            );
            validate_directory_rule(&rule.directory, &rule.template)?;
        }
        for rule in &manifest.service_files {
            validate_directory_rule(&rule.directory, &rule.template)?;
            ensure!(
                valid_identifier(&format!("Service{}", rule.suffix)),
                "invalid TypeScript service suffix {:?}",
                rule.suffix
            );
        }
        Ok(Self {
            root: path
                .parent()
                .context("profile has no parent directory")?
                .to_owned(),
            files: manifest.files,
            model_files: manifest.model_files,
            service_files: manifest.service_files,
            batch_files: manifest.batch_files,
            typescript: manifest.typescript,
            options: manifest.options,
        })
    }

    pub fn render(&self, context: &ContextData<'_>) -> Result<FilePlan> {
        Ok(FilePlan::new(
            self.render_document(&self.environment(), context)?,
        ))
    }

    pub fn render_batch(
        &self,
        documents: &[Document],
        reference_root: Option<&Path>,
    ) -> Result<FilePlan> {
        ensure!(!documents.is_empty(), "generation batch has no documents");
        let mut namespaces = BTreeSet::new();
        let mut directories = BTreeSet::new();
        for document in documents {
            ensure!(
                valid_identifier(&document.namespace),
                "invalid document namespace {:?}",
                document.namespace
            );
            ensure!(
                namespaces.insert(&document.namespace),
                "duplicate document namespace {:?}",
                document.namespace
            );
            ensure!(
                directories.insert(document.directory.to_ascii_lowercase()),
                "duplicate document directory {:?}",
                document.directory
            );
            ensure!(
                is_relative(&document.directory)
                    && !document.directory.contains('/')
                    && !output::is_reserved(&document.directory),
                "invalid document directory {:?}",
                document.directory
            );
        }
        let environment = self.environment();
        let mut files = BTreeMap::new();
        let batch = minijinja::context! { documents => documents, options => &self.options };
        for (output, template) in &self.batch_files {
            files.insert(
                output.clone(),
                render(&environment, template, output, batch.clone())?,
            );
        }
        for document in documents {
            let api = crate::openapi::load(&document.spec, reference_root)?;
            let context = crate::typescript::context(&api, &self.options, &self.typescript)?;
            for (output, contents) in self.render_document(&environment, &context)? {
                let path = format!("{}/{output}", document.directory);
                ensure!(
                    files.insert(path.clone(), contents).is_none(),
                    "output paths collide: {path:?}"
                );
            }
        }
        validate_paths(files.keys().map(String::as_str))?;
        Ok(FilePlan::new(files))
    }

    fn environment(&self) -> Environment<'static> {
        let mut environment = Environment::new();
        environment.set_undefined_behavior(UndefinedBehavior::Strict);
        environment.set_auto_escape_callback(|_| AutoEscape::None);
        environment.set_keep_trailing_newline(true);
        environment.set_fuel(Some(5_000_000));
        environment.add_filter("ts_string", |value: String| {
            serde_json::Value::String(value).to_string()
        });
        environment.add_filter("ts_identifier", |value: String| {
            if valid_identifier(&value) {
                Ok(value)
            } else {
                Err(template_error(format!(
                    "invalid TypeScript identifier {value:?}"
                )))
            }
        });
        environment.add_function(
            "fail",
            |message: String| -> Result<String, minijinja::Error> { Err(template_error(message)) },
        );
        let root = self.root.clone();
        environment.set_loader(move |name| {
            if !is_relative(name) {
                return Err(template_error(format!("invalid template path {name:?}")));
            }
            let resolved = match root.join(name).canonicalize() {
                Ok(resolved) => resolved,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(template_error(format!("{name}: {error}"))),
            };
            if !resolved.starts_with(&root) || !resolved.is_file() {
                return Err(template_error(format!(
                    "not a regular template inside the profile: {name:?}"
                )));
            }
            fs::read_to_string(resolved)
                .map(Some)
                .map_err(|error| template_error(format!("{name}: {error}")))
        });
        environment
    }

    fn render_document(
        &self,
        environment: &Environment<'_>,
        context: &ContextData<'_>,
    ) -> Result<BTreeMap<String, String>> {
        let base = minijinja::Value::from_serialize(context);
        let mut outputs = self
            .files
            .iter()
            .map(|(path, template)| (path.clone(), (template.as_str(), TemplateScope::Document)))
            .collect::<BTreeMap<_, _>>();

        for model in context.models() {
            let kind = if model.is_enum() {
                ModelKind::Enum
            } else if model.is_type_alias() {
                ModelKind::Type
            } else {
                ModelKind::Interface
            };
            for rule in self.model_files.iter().filter(|rule| rule.kind == kind) {
                let path = format!("{}/{}.ts", rule.directory, model.name());
                ensure!(
                    !outputs.contains_key(&path),
                    "output paths collide: {path:?}"
                );
                outputs.insert(path, (rule.template.as_str(), TemplateScope::Model(model)));
            }
        }
        for service in context.services() {
            for rule in &self.service_files {
                let path = format!(
                    "{}/{}{}.ts",
                    rule.directory,
                    service.type_name(),
                    rule.suffix
                );
                ensure!(
                    !outputs.contains_key(&path),
                    "output paths collide for service {:?}: {path:?}",
                    service.name()
                );
                outputs.insert(
                    path,
                    (rule.template.as_str(), TemplateScope::Service(service)),
                );
            }
        }

        validate_paths(outputs.keys().map(String::as_str))?;
        ensure!(!outputs.is_empty(), "profile did not generate any files");
        let mut files = BTreeMap::new();
        for (output, (template, scope)) in outputs {
            let value = match scope {
                TemplateScope::Document => base.clone(),
                TemplateScope::Model(model) => {
                    minijinja::context! { model => model, ..base.clone() }
                }
                TemplateScope::Service(service) => {
                    minijinja::context! { service => service, ..base.clone() }
                }
            };
            let contents = render(environment, template, &output, value)?;
            files.insert(output, contents);
        }
        Ok(files)
    }
}

fn render(
    environment: &Environment<'_>,
    template: &str,
    output: &str,
    value: minijinja::Value,
) -> Result<String> {
    environment
        .get_template(template)
        .and_then(|template| template.render(value))
        .with_context(|| format!("render {template:?} for {output:?}"))
}

fn validate_file_rules(rules: &BTreeMap<String, String>) -> Result<()> {
    validate_paths(rules.keys().map(String::as_str))?;
    for (output, template) in rules {
        ensure!(
            !output::is_reserved(output),
            "reserved output path {output:?}"
        );
        ensure!(is_relative(template), "invalid template path {template:?}");
    }
    Ok(())
}

fn validate_directory_rule(directory: &str, template: &str) -> Result<()> {
    ensure!(
        is_relative(directory) && !output::is_reserved(directory),
        "invalid output directory {directory:?}"
    );
    ensure!(is_relative(template), "invalid template path {template:?}");
    Ok(())
}

impl Starter {
    pub fn install(self, output: &Path) -> Result<()> {
        let files: &[(&str, &str)] = match self {
            Self::Fetch => &[
                (
                    "profile.json",
                    include_str!("../../examples/profiles/fetch/profile.json"),
                ),
                (
                    "client.jinja",
                    include_str!("../../examples/profiles/fetch/client.jinja"),
                ),
                (
                    "sse.jinja",
                    include_str!("../../examples/profiles/fetch/sse.jinja"),
                ),
            ],
            Self::Transport => &[
                (
                    "profile.json",
                    include_str!("../../examples/profiles/transport/profile.json"),
                ),
                (
                    "client.jinja",
                    include_str!("../../examples/profiles/transport/client.jinja"),
                ),
                (
                    "routes.jinja",
                    include_str!("../../examples/profiles/transport/routes.jinja"),
                ),
                (
                    "interfaces/ITransport.jinja",
                    include_str!("../../examples/profiles/transport/interfaces/ITransport.jinja"),
                ),
                (
                    "interfaces/ITransportRequest.jinja",
                    include_str!(
                        "../../examples/profiles/transport/interfaces/ITransportRequest.jinja"
                    ),
                ),
                (
                    "interfaces/ITransportResponse.jinja",
                    include_str!(
                        "../../examples/profiles/transport/interfaces/ITransportResponse.jinja"
                    ),
                ),
                (
                    "interfaces/IQuivraEvent.jinja",
                    include_str!("../../examples/profiles/transport/interfaces/IQuivraEvent.jinja"),
                ),
                (
                    "interfaces/model.jinja",
                    include_str!("../../examples/profiles/transport/interfaces/model.jinja"),
                ),
                (
                    "types/model.jinja",
                    include_str!("../../examples/profiles/transport/types/model.jinja"),
                ),
            ],
        };
        output::install_starter(output, files)
    }
}

fn validate_paths<'a>(paths: impl Iterator<Item = &'a str>) -> Result<()> {
    let mut names = BTreeSet::new();
    let mut prefixes = BTreeMap::new();
    for path in paths {
        ensure!(is_relative(path), "invalid output path {path:?}");
        ensure!(
            names.insert(path.to_ascii_lowercase()),
            "output paths collide: {path:?}"
        );
        for (index, _) in path.match_indices('/') {
            let prefix = &path[..index];
            let prior = prefixes
                .entry(prefix.to_ascii_lowercase())
                .or_insert(prefix);
            ensure!(
                *prior == prefix,
                "output directories differ only in casing: {prior:?} and {prefix:?}"
            );
        }
    }
    for (name, original) in prefixes {
        ensure!(
            !names.contains(&name),
            "output path {original:?} is both a file and a directory"
        );
    }
    Ok(())
}

fn is_relative(name: &str) -> bool {
    name.split('/').all(|part| {
        let basename = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let windows_device = matches!(basename.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (basename.len() == 4
                && (basename.starts_with("COM") || basename.starts_with("LPT"))
                && matches!(basename.as_bytes()[3], b'1'..=b'9'));
        !windows_device
            && !part.is_empty()
            && !part.ends_with('.')
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.$".contains(&byte))
    })
}

fn unique_file_map<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct UniqueFileMap;
    impl<'de> serde::de::Visitor<'de> for UniqueFileMap {
        type Value = BTreeMap<String, String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a map of unique file paths to strings")
        }

        fn visit_map<M>(self, mut map: M) -> Result<Self::Value, M::Error>
        where
            M: serde::de::MapAccess<'de>,
        {
            let mut files = BTreeMap::new();
            while let Some((path, value)) = map.next_entry::<String, String>()? {
                use std::collections::btree_map::Entry;
                match files.entry(path) {
                    Entry::Occupied(entry) => {
                        return Err(serde::de::Error::custom(format!(
                            "duplicate file path {:?}",
                            entry.key()
                        )));
                    }
                    Entry::Vacant(entry) => {
                        entry.insert(value);
                    }
                }
            }
            Ok(files)
        }
    }
    deserializer.deserialize_map(UniqueFileMap)
}

fn template_error(message: String) -> minijinja::Error {
    minijinja::Error::new(minijinja::ErrorKind::InvalidOperation, message)
}
