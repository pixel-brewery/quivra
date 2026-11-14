use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use minijinja::{AutoEscape, Environment, UndefinedBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tempfile::NamedTempFile;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    version: u32,
    files: BTreeMap<String, String>,
    #[serde(default)]
    pub options: BTreeMap<String, Value>,
}

pub struct FilePlan(BTreeMap<String, String>);

impl Profile {
    pub fn load(path: &Path) -> Result<Self> {
        let contents =
            fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let profile: Self =
            serde_json::from_str(&contents).with_context(|| format!("parse {}", path.display()))?;
        ensure!(
            profile.version == 1,
            "unsupported profile version {}",
            profile.version
        );
        ensure!(
            !profile.files.is_empty(),
            "profile must declare at least one output file"
        );
        profile.validate_files()?;
        Ok(profile)
    }

    fn validate_files(&self) -> Result<()> {
        let mut names = BTreeSet::new();
        for (output, template) in &self.files {
            ensure!(is_relative(output), "invalid output path {output:?}");
            ensure!(is_relative(template), "invalid template path {template:?}");
            ensure!(
                names.insert(output.to_ascii_lowercase()),
                "output paths collide: {output:?}"
            );
        }
        for name in &names {
            for (index, _) in name.match_indices('/') {
                ensure!(
                    !names.contains(&name[..index]),
                    "output path {name:?} has a file as a parent"
                );
            }
        }
        Ok(())
    }

    pub fn render(&self, root: &Path, context: &impl Serialize) -> Result<FilePlan> {
        let root = fs::canonicalize(root)
            .with_context(|| format!("resolve profile directory {}", root.display()))?;
        let mut environment = Environment::new();
        environment.set_undefined_behavior(UndefinedBehavior::Strict);
        environment.set_auto_escape_callback(|_| AutoEscape::None);
        environment.add_filter("ts_string", |value: String| {
            // A Rust string always serializes to a JSON string and therefore a TS string literal.
            serde_json::Value::String(value).to_string()
        });
        environment.set_loader(move |name| {
            if !is_relative(name) {
                return Err(template_error(format!("invalid template path {name:?}")));
            }

            let resolved = match root.join(name).canonicalize() {
                Ok(resolved) => resolved,
                Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(template_error(format!("{name}: {error}"))),
            };
            if !resolved.starts_with(&root) {
                return Err(template_error(format!(
                    "template escapes the profile: {name:?}"
                )));
            }
            fs::read_to_string(resolved)
                .map(Some)
                .map_err(|error| template_error(format!("{name}: {error}")))
        });

        let mut files = BTreeMap::new();
        for (output, template) in &self.files {
            let contents = environment
                .get_template(template)
                .and_then(|template| template.render(context))
                .with_context(|| format!("render {template:?} for {output:?}"))?;
            files.insert(output.clone(), contents);
        }
        Ok(FilePlan(files))
    }
}

impl FilePlan {
    pub fn write(self, directory: &Path) -> Result<()> {
        check_kind(directory, true)?;
        for name in self.0.keys() {
            let mut current = directory.to_path_buf();
            let segments = name.split('/');
            let count = segments.clone().count();
            for (index, segment) in segments.enumerate() {
                current.push(segment);
                check_kind(&current, index + 1 < count)?;
            }
        }

        let mut staged = Vec::new();
        for (name, content) in self.0 {
            let output = directory.join(&name);
            let parent = output.parent().context("output path has no parent")?;
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
            let mut file = NamedTempFile::new_in(parent)
                .with_context(|| format!("stage {}", output.display()))?;
            file.write_all(content.as_bytes())
                .with_context(|| format!("write {}", output.display()))?;
            staged.push((output, file));
        }
        for (output, file) in staged {
            file.persist(&output)
                .with_context(|| format!("publish {}", output.display()))?;
            println!("{}", output.display());
        }
        Ok(())
    }
}

pub fn manifest_path(path: PathBuf) -> Result<(PathBuf, PathBuf)> {
    if path.is_dir() {
        return Ok((path.join("profile.json"), path));
    }
    ensure!(path.is_file(), "profile not found: {}", path.display());
    let root = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    Ok((path, root))
}

fn is_relative(name: &str) -> bool {
    name.split('/').all(|part| {
        !part.is_empty()
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    })
}

fn template_error(message: String) -> minijinja::Error {
    minijinja::Error::new(minijinja::ErrorKind::InvalidOperation, message)
}

fn check_kind(path: &Path, directory: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let expected_kind = if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            };
            ensure!(
                expected_kind,
                "unexpected output file type at {}",
                path.display()
            );
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error).with_context(|| format!("inspect {}", path.display())),
    }
    Ok(())
}
