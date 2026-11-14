use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

use super::validate_paths;

const MANIFEST: &str = ".quivra-manifest.json";
const PENDING: &str = ".quivra-pending.json";
const LOCK: &str = ".quivra.lock";

type Digests = BTreeMap<String, String>;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    version: u8,
    files: Digests,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pending {
    version: u8,
    previous: Digests,
    next: Digests,
}

pub struct FilePlan(BTreeMap<String, String>);

impl FilePlan {
    pub(super) fn new(files: BTreeMap<String, String>) -> Self {
        Self(files)
    }

    pub fn check(&self, output: &Path) -> Result<()> {
        ensure!(
            directory(output)?,
            "output directory is missing: {}",
            output.display()
        );
        let lock_path = output.join(LOCK);
        let _lock = if regular_file(&lock_path)? {
            let lock = File::open(&lock_path)?;
            lock.lock_shared().context("lock output for checking")?;
            Some(lock)
        } else {
            None
        };

        ensure!(
            !regular_file(&output.join(PENDING))?,
            "a generation was interrupted. Re-run generate to finish it"
        );
        let owned: Ownership =
            read_metadata(output, MANIFEST)?.context("output has no Quivra manifest")?;
        owned.validate()?;
        let expected = self.digests();
        let mut drift = Vec::new();
        for name in combined_paths(&owned.files, &expected) {
            let current = read_output(output, name)?.map(|bytes| digest(&bytes));
            if owned.files.get(name) != expected.get(name) || current.as_ref() != expected.get(name)
            {
                drift.push(name);
            }
        }
        ensure!(
            drift.is_empty(),
            "generated output is out of date:\n{}",
            drift.join("\n")
        );
        Ok(())
    }

    pub fn write(self, output: &Path) -> Result<Vec<PathBuf>> {
        create_output(output)?;
        let _lock = lock_output(output)?;
        let next = self.digests();
        let ownership =
            read_metadata(output, MANIFEST)?.unwrap_or_else(|| Ownership::new(Digests::new()));
        ownership.validate()?;
        let pending: Option<Pending> = read_metadata(output, PENDING)?;
        let recovery = pending.is_some();
        let previous = match pending {
            Some(pending) => {
                ensure!(
                    pending.version == 1,
                    "unsupported generation journal version {}",
                    pending.version
                );
                validate_inventory(&pending.previous)?;
                validate_inventory(&pending.next)?;
                ensure!(
                    pending.next == next,
                    "an interrupted generation is pending. Re-run with its original inputs"
                );
                ensure!(
                    ownership.files == pending.previous || ownership.files == pending.next,
                    "invalid pending ownership state"
                );
                pending.previous
            }
            None => ownership.files,
        };

        // A union cannot use a directory as a file or change a path's casing across runs.
        let names = combined_paths(&previous, &next);
        validate_paths(names.iter().copied())?;

        let mut changed = Vec::new();
        let mut obsolete = Vec::new();
        for name in names {
            let current = read_output(output, name)?.map(|bytes| digest(&bytes));
            let before = previous.get(name);
            let after = next.get(name);
            if current.as_ref() == after {
                continue;
            }
            if current.is_some() && current.as_ref() != before {
                bail!(
                    "refusing to replace an unowned or edited file: {}",
                    output.join(name).display()
                );
            }
            if let Some(content) = self.0.get(name) {
                changed.push((output.join(name), content.as_bytes()));
            } else {
                obsolete.push(output.join(name));
            }
        }

        let written = self.0.keys().map(|name| output.join(name)).collect();
        if !recovery && changed.is_empty() && obsolete.is_empty() && previous == next {
            return Ok(written);
        }
        let mut staged = Vec::new();
        for (path, content) in &changed {
            staged.push((path, stage_file(path, content)?));
        }
        let manifest_path = output.join(MANIFEST);
        let manifest_contents = metadata_bytes(&Ownership::new(next.clone()))?;
        let staged_manifest = stage_file(&manifest_path, &manifest_contents)?;

        // An interrupted run can be resumed with the same inputs. The journal records
        // both acceptable digests before the first generated file is changed.
        let pending_path = output.join(PENDING);
        let pending_contents = metadata_bytes(&Pending {
            version: 1,
            previous,
            next,
        })?;
        persist(stage_file(&pending_path, &pending_contents)?, &pending_path)?;
        for (path, staged_file) in staged {
            persist(staged_file, path)?;
        }
        for path in obsolete {
            fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
        persist(staged_manifest, &manifest_path)?;
        fs::remove_file(&pending_path).context("remove completed generation journal")?;

        Ok(written)
    }

    fn digests(&self) -> Digests {
        self.0
            .iter()
            .map(|(name, text)| (name.clone(), digest(text.as_bytes())))
            .collect()
    }
}

impl Ownership {
    fn new(files: Digests) -> Self {
        Self { version: 1, files }
    }

    fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1,
            "unsupported output manifest version {}",
            self.version
        );
        validate_inventory(&self.files)
    }
}

pub(super) fn install_starter(output: &Path, files: &[(&str, &str)]) -> Result<()> {
    create_output(output)?;
    let _lock = lock_output(output)?;
    for (name, _) in files {
        let path = output.join(name);
        ensure!(
            read_output(output, name)?.is_none(),
            "starter profile would overwrite {}",
            path.display()
        );
    }

    let staged = files
        .iter()
        .map(|(name, text)| {
            let path = output.join(name);
            Ok((stage_file(&path, text.as_bytes())?, path))
        })
        .collect::<Result<Vec<_>>>()?;
    for (file, path) in staged {
        file.persist_noclobber(&path)
            .with_context(|| format!("create {}", path.display()))?;
        println!("{}", path.display());
    }
    Ok(())
}

pub(super) fn is_reserved(path: &str) -> bool {
    let first = path.split('/').next().unwrap_or_default();
    [MANIFEST, PENDING, LOCK]
        .iter()
        .any(|reserved| first.eq_ignore_ascii_case(reserved))
}

fn validate_inventory(files: &Digests) -> Result<()> {
    validate_paths(files.keys().map(String::as_str))?;
    for (name, hash) in files {
        ensure!(
            !is_reserved(name),
            "reserved path in ownership metadata {name:?}"
        );
        ensure!(
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid digest for {name:?}"
        );
    }
    Ok(())
}

fn combined_paths<'a>(first: &'a Digests, second: &'a Digests) -> BTreeSet<&'a str> {
    first
        .keys()
        .chain(second.keys())
        .map(String::as_str)
        .collect()
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn metadata_bytes(value: &impl Serialize) -> Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn read_metadata<T: serde::de::DeserializeOwned>(output: &Path, name: &str) -> Result<Option<T>> {
    read_output(output, name)?
        .map(|bytes| {
            serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", output.join(name).display()))
        })
        .transpose()
}

fn read_output(output: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    let mut path = output.to_owned();
    let mut segments = name.split('/').peekable();
    while let Some(segment) = segments.next() {
        path.push(segment);
        if segments.peek().is_some() && !directory(&path)? {
            return Ok(None);
        }
    }
    if regular_file(&path)? {
        Ok(Some(
            fs::read(&path).with_context(|| format!("read {}", path.display()))?,
        ))
    } else {
        Ok(None)
    }
}

fn create_output(output: &Path) -> Result<()> {
    if !directory(output)? {
        fs::create_dir_all(output).with_context(|| format!("create {}", output.display()))?;
        directory(output)?;
    }
    Ok(())
}

fn lock_output(output: &Path) -> Result<File> {
    let lock_path = output.join(LOCK);
    regular_file(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .with_context(|| format!("open {}", lock_path.display()))?;
    lock.lock()
        .with_context(|| format!("lock {}", lock_path.display()))?;
    Ok(lock)
}

fn directory(path: &Path) -> Result<bool> {
    verify_kind(path, "directory", |metadata| metadata.is_dir())
}

fn regular_file(path: &Path) -> Result<bool> {
    verify_kind(path, "regular file", |metadata| metadata.is_file())
}

fn verify_kind(
    path: &Path,
    expected: &str,
    check: impl FnOnce(&fs::Metadata) -> bool,
) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure!(
                check(&metadata),
                "expected {expected} at {}",
                path.display()
            );
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("inspect {}", path.display())),
    }
}

fn stage_file(path: &Path, contents: &[u8]) -> Result<NamedTempFile> {
    let parent = path.parent().context("output file has no parent")?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let mut file =
        NamedTempFile::new_in(parent).with_context(|| format!("stage {}", path.display()))?;
    file.write_all(contents)
        .with_context(|| format!("write {}", path.display()))?;
    Ok(file)
}

fn persist(file: NamedTempFile, path: &Path) -> Result<()> {
    file.persist(path)
        .with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}
