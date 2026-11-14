use std::collections::BTreeMap;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use anyhow::{Context, Result, bail, ensure};
use serde_json::Value;

const MAX_DOCUMENTS: usize = 128;
const MAX_DOCUMENT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) struct Location {
    pub path: PathBuf,
    pub pointer: String,
}

pub(super) struct Documents {
    root: PathBuf,
    files: BTreeMap<PathBuf, Rc<Value>>,
    total_bytes: u64,
}

impl Documents {
    pub fn new(entry: &Path, reference_root: Option<&Path>) -> Result<(Self, Location)> {
        let path = entry
            .canonicalize()
            .with_context(|| format!("resolve specification {}", entry.display()))?;
        let root = match reference_root {
            Some(root) => {
                let root = root
                    .canonicalize()
                    .with_context(|| format!("resolve reference root {}", root.display()))?;
                ensure!(root.is_dir(), "reference root must be a directory");
                root
            }
            None => path
                .parent()
                .context("specification has no parent directory")?
                .to_path_buf(),
        };
        ensure!(
            path.starts_with(&root),
            "specification is outside the reference root"
        );
        Ok((
            Self {
                root,
                files: BTreeMap::new(),
                total_bytes: 0,
            },
            Location {
                path,
                pointer: String::new(),
            },
        ))
    }

    pub fn resolve(&self, from: &Location, reference: &str) -> Result<Location> {
        let (path, fragment) = reference.split_once('#').unwrap_or((reference, ""));
        ensure!(
            !fragment.contains('#'),
            "invalid reference fragment: {reference:?}"
        );
        let path = percent_decode(path)?;
        let path = if path.is_empty() {
            from.path.clone()
        } else {
            ensure!(
                !path.starts_with('/') && !path.contains([':', '\\', '?', '\0']),
                "only relative local references are supported: {reference:?}"
            );
            let path = from
                .path
                .parent()
                .context("reference source has no parent")?
                .join(path);
            path.canonicalize().with_context(|| {
                format!("resolve reference {reference:?} in {}", from.path.display())
            })?
        };
        ensure!(
            path.starts_with(&self.root),
            "reference escapes the reference root: {reference:?}"
        );
        let pointer = percent_decode(fragment)?;
        ensure!(
            pointer.is_empty() || pointer.starts_with('/'),
            "only JSON Pointer fragments are supported: {reference:?}"
        );
        for token in pointer.split('/').skip(1) {
            validate_token(token)?;
        }
        Ok(Location { path, pointer })
    }

    pub fn document(&mut self, path: &Path) -> Result<Rc<Value>> {
        if let Some(document) = self.files.get(path) {
            return Ok(Rc::clone(document));
        }
        ensure!(
            self.files.len() < MAX_DOCUMENTS,
            "too many documents in the reference graph"
        );
        ensure!(
            path.metadata()?.is_file(),
            "reference target is not a regular file: {}",
            path.display()
        );
        let mut bytes = Vec::new();
        let limit = MAX_DOCUMENT_BYTES.min(MAX_TOTAL_BYTES - self.total_bytes);
        File::open(path)?
            .take(limit + 1)
            .read_to_end(&mut bytes)
            .with_context(|| format!("read {}", path.display()))?;
        let size = bytes.len() as u64;
        ensure!(
            size <= limit,
            "OpenAPI document size limit exceeded while reading {}",
            path.display()
        );
        self.total_bytes += size;
        let json = match serde_json::from_slice(&bytes) {
            Ok(json) => json,
            Err(_) => {
                let mut yaml: serde_yaml_ng::Value = serde_yaml_ng::from_slice(&bytes)
                    .with_context(|| format!("parse {}", path.display()))?;
                yaml.apply_merge()
                    .with_context(|| format!("apply YAML merge keys in {}", path.display()))?;
                serde_json::to_value(yaml).with_context(|| {
                    format!("convert {} to a JSON-compatible document", path.display())
                })?
            }
        };
        let document = Rc::new(json);
        self.files.insert(path.to_path_buf(), Rc::clone(&document));
        Ok(document)
    }

    pub fn reject_base_uri_ancestors(&mut self, location: &Location) -> Result<()> {
        let document = self.document(&location.path)?;
        for (index, _) in location.pointer.match_indices('/') {
            if document
                .pointer(&location.pointer[..index])
                .is_some_and(|node| node.get("$id").is_some())
            {
                bail!(
                    "schema in {}#{} has an unsupported inherited $id",
                    location.path.display(),
                    location.pointer
                );
            }
        }
        Ok(())
    }

    pub fn get(&mut self, location: &Location) -> Result<Value> {
        let document = self.document(&location.path)?;
        document
            .pointer(&location.pointer)
            .cloned()
            .with_context(|| {
                format!(
                    "unknown reference {}#{}",
                    location.path.display(),
                    location.pointer
                )
            })
    }
}

fn percent_decode(input: &str) -> Result<String> {
    let mut bytes = Vec::with_capacity(input.len());
    let mut input = input.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(hex);
            let low = input.next().and_then(hex);
            let (Some(high), Some(low)) = (high, low) else {
                bail!("invalid percent escape in reference");
            };
            bytes.push(high * 16 + low);
        } else {
            bytes.push(byte);
        }
    }
    String::from_utf8(bytes).context("reference percent escape is not UTF-8")
}

fn hex(byte: u8) -> Option<u8> {
    (byte as char).to_digit(16).map(|digit| digit as u8)
}

fn validate_token(token: &str) -> Result<()> {
    let mut characters = token.chars();
    while let Some(character) = characters.next() {
        if character == '~' {
            ensure!(
                matches!(characters.next(), Some('0' | '1')),
                "invalid JSON Pointer escape in {token:?}"
            );
        }
    }
    Ok(())
}

pub(super) fn escape_token(token: &str) -> String {
    token.replace('~', "~0").replace('/', "~1")
}
