mod openapi;
mod profile;
mod typescript;

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Generate a TypeScript client with a project-owned profile.
    Generate {
        /// OpenAPI 3.0 document in YAML or JSON.
        spec: PathBuf,
        /// Profile directory or path to profile.json.
        #[arg(long)]
        profile: PathBuf,
        /// Directory to write generated files into.
        #[arg(long)]
        out: PathBuf,
    },
    /// Print the JSON context passed to every template.
    Inspect {
        spec: PathBuf,
        #[arg(long)]
        profile: PathBuf,
    },
}

fn main() -> Result<()> {
    let (spec_path, profile_path, output) = match Cli::parse().command {
        Command::Generate { spec, profile, out } => (spec, profile, Some(out)),
        Command::Inspect { spec, profile } => (spec, profile, None),
    };
    let document =
        fs::read_to_string(&spec_path).with_context(|| format!("read {}", spec_path.display()))?;
    let api =
        openapi::parse(&document).with_context(|| format!("parse {}", spec_path.display()))?;
    let (manifest, templates) = profile::manifest_path(profile_path)?;
    let profile = profile::Profile::load(&manifest)?;
    let context = typescript::context(&api, &profile.options)?;
    match output {
        Some(output) => profile.render(&templates, &context)?.write(&output)?,
        None => println!("{}", serde_json::to_string_pretty(&context)?),
    }
    Ok(())
}
