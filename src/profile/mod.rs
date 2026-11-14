mod output;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use minijinja::{AutoEscape, Environment, UndefinedBehavior};
use serde::Deserialize;
use serde_json::Value;

use crate::typescript::{ContextData, valid_identifier};
pub use output::FilePlan;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Manifest {
    version: u32,
    #[serde(deserialize_with = "unique_file_map")]
    files: BTreeMap<String, String>,
    #[serde(default)]
    model_files: Vec<ModelFiles>,
    #[serde(default)]
    typescript: TypeScriptOptions,
    #[serde(default)]
    options: BTreeMap<String, Value>,
}

pub struct Profile {
    root: PathBuf,
    files: BTreeMap<String, String>,
    model_files: Vec<ModelFiles>,
    pub typescript: TypeScriptOptions,
    pub options: BTreeMap<String, Value>,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TypeScriptOptions {
    #[serde(default)]
    pub interface_prefix: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelFiles {
    kind: ModelKind,
    directory: String,
    template: String,
}

#[derive(Clone, Copy, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "lowercase")]
enum ModelKind {
    Interface,
    Type,
}

pub enum Starter {
    Fetch,
    Transport,
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
            manifest.version == 1,
            "unsupported profile version {}",
            manifest.version
        );
        ensure!(
            !(manifest.files.is_empty() && manifest.model_files.is_empty()),
            "profile must declare at least one output file"
        );
        validate_paths(manifest.files.keys().map(String::as_str))?;
        for (output, template) in &manifest.files {
            ensure!(
                !output::is_reserved(output),
                "reserved output path {output:?}"
            );
            ensure!(is_relative(template), "invalid template path {template:?}");
        }
        let mut kinds = BTreeSet::new();
        for rule in &manifest.model_files {
            ensure!(
                kinds.insert(rule.kind),
                "duplicate modelFiles rule for one model kind"
            );
            ensure!(
                is_relative(&rule.directory),
                "invalid model directory {:?}",
                rule.directory
            );
            ensure!(
                !output::is_reserved(&rule.directory),
                "reserved model directory {:?}",
                rule.directory
            );
            ensure!(
                is_relative(&rule.template),
                "invalid model template {:?}",
                rule.template
            );
        }
        let prefix = &manifest.typescript.interface_prefix;
        ensure!(
            prefix.is_empty() || valid_identifier(prefix),
            "invalid TypeScript interface prefix {prefix:?}"
        );
        Ok(Self {
            root: path
                .parent()
                .context("profile has no parent directory")?
                .to_owned(),
            files: manifest.files,
            model_files: manifest.model_files,
            typescript: manifest.typescript,
            options: manifest.options,
        })
    }

    pub fn render(&self, context: &ContextData<'_>) -> Result<FilePlan> {
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

        let base = minijinja::Value::from_serialize(context);
        let mut outputs = self
            .files
            .iter()
            .map(|(path, template)| (path.clone(), (template.as_str(), None)))
            .collect::<BTreeMap<_, _>>();

        for model in context.models() {
            let kind = if model.is_type_alias() {
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
                outputs.insert(path, (rule.template.as_str(), Some(model)));
            }
        }

        validate_paths(outputs.keys().map(String::as_str))?;
        ensure!(!outputs.is_empty(), "profile did not generate any files");
        let mut files = BTreeMap::new();
        for (output, (template, model)) in outputs {
            let value = match model {
                Some(model) => minijinja::context! { model => model, ..base.clone() },
                None => base.clone(),
            };
            let contents = environment
                .get_template(template)
                .and_then(|template| template.render(value))
                .with_context(|| format!("render {template:?} for {output:?}"))?;
            files.insert(output, contents);
        }
        Ok(FilePlan::new(files))
    }
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
