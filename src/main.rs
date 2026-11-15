mod openapi;
mod profile;
mod typescript;

use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Copy an editable starter profile into your project.
    Init {
        #[arg(long, value_enum, default_value_t = Preset::Fetch)]
        preset: Preset,
        /// Directory in which to create the profile.
        #[arg(long)]
        out: PathBuf,
    },
    /// Generate a TypeScript client with a project-owned profile.
    Generate {
        #[command(flatten)]
        input: Input,
        /// Directory to write generated files into.
        #[arg(long)]
        out: PathBuf,
        /// Compare generated files with disk instead of writing them.
        #[arg(long)]
        check: bool,
    },
    /// Generate a namespace directory per document as one output set.
    GenerateBatch {
        /// JSON array of documents with namespace, directory and spec fields.
        batch: PathBuf,
        /// Profile directory or path to its manifest.
        #[arg(long)]
        profile: PathBuf,
        /// Root directory allowed for local OpenAPI references.
        #[arg(long)]
        reference_root: Option<PathBuf>,
        /// Directory to write generated files into.
        #[arg(long)]
        out: PathBuf,
        /// Compare generated files with disk instead of writing them.
        #[arg(long)]
        check: bool,
    },
    /// Print the JSON context passed to every template.
    Inspect {
        #[command(flatten)]
        input: Input,
    },
    /// Print the JSON Schema for a Quivra configuration file.
    Schema {
        #[arg(value_enum)]
        kind: ConfigurationSchema,
    },
}

#[derive(Args)]
struct Input {
    /// OpenAPI 3.0 or 3.1 document in YAML or JSON.
    spec: PathBuf,
    /// Profile directory or path to its manifest.
    #[arg(long)]
    profile: PathBuf,
    /// Root directory allowed for local OpenAPI references. Defaults to the spec's directory.
    #[arg(long)]
    reference_root: Option<PathBuf>,
}

#[derive(Clone, Copy, ValueEnum)]
enum Preset {
    Fetch,
    Transport,
}

#[derive(Clone, Copy, ValueEnum)]
enum ConfigurationSchema {
    Profile,
    Batch,
}

fn main() -> Result<()> {
    match Cli::parse().command {
        Command::Init { preset, out } => {
            let preset = match preset {
                Preset::Fetch => profile::Starter::Fetch,
                Preset::Transport => profile::Starter::Transport,
            };
            preset.install(&out)?;
        }
        Command::Generate { input, out, check } => {
            let api = openapi::load(&input.spec, input.reference_root.as_deref())?;
            let profile = profile::Profile::load(&input.profile)?;
            let context = typescript::context(&api, &profile.options, &profile.typescript)?;
            emit(profile.render(&context)?, out, check)?;
        }
        Command::GenerateBatch {
            batch,
            profile,
            reference_root,
            out,
            check,
        } => {
            let bytes = fs::read(&batch).with_context(|| format!("read {}", batch.display()))?;
            let mut documents: Vec<profile::Document> = serde_json::from_slice(&bytes)
                .with_context(|| format!("parse {}", batch.display()))?;
            let base = batch.parent().context("batch has no parent directory")?;
            for document in &mut documents {
                document.spec = base.join(&document.spec);
            }
            let profile = profile::Profile::load(&profile)?;
            let plan = profile.render_batch(&documents, reference_root.as_deref())?;
            emit(plan, out, check)?;
        }
        Command::Inspect { input } => {
            let api = openapi::load(&input.spec, input.reference_root.as_deref())?;
            let profile = profile::Profile::load(&input.profile)?;
            let context = typescript::context(&api, &profile.options, &profile.typescript)?;
            println!("{}", serde_json::to_string_pretty(&context)?);
        }
        Command::Schema { kind } => {
            let schema = match kind {
                ConfigurationSchema::Profile => profile::profile_schema(),
                ConfigurationSchema::Batch => profile::batch_schema(),
            };
            println!("{}", serde_json::to_string_pretty(&schema)?);
        }
    }
    Ok(())
}

fn emit(plan: profile::FilePlan, out: PathBuf, check: bool) -> Result<()> {
    if check {
        return plan.check(&out);
    }
    for file in plan.write(&out)? {
        println!("{}", file.display());
    }
    Ok(())
}
