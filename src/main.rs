mod openapi;
mod profile;
mod typescript;

use std::path::PathBuf;

use anyhow::Result;
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
    /// Print the JSON context passed to every template.
    Inspect {
        #[command(flatten)]
        input: Input,
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
            let context =
                typescript::context(&api, &profile.options, &profile.typescript.interface_prefix)?;
            let plan = profile.render(&context)?;
            if check {
                plan.check(&out)?;
            } else {
                for file in plan.write(&out)? {
                    println!("{}", file.display());
                }
            }
        }
        Command::Inspect { input } => {
            let api = openapi::load(&input.spec, input.reference_root.as_deref())?;
            let profile = profile::Profile::load(&input.profile)?;
            let context =
                typescript::context(&api, &profile.options, &profile.typescript.interface_prefix)?;
            println!("{}", serde_json::to_string_pretty(&context)?);
        }
    }
    Ok(())
}
