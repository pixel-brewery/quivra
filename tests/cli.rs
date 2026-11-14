use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use tempfile::tempdir;

fn cli(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_quivra"))
        .args(args)
        .output()
        .expect("start quivra")
}

fn success(output: Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn failure(output: Output, message: &str) {
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains(message), "{stderr}");
}

fn generate(profile: &Path, destination: &Path, check: bool) -> Output {
    let mut args = vec![
        "generate",
        "examples/openapi.yaml",
        "--profile",
        profile.to_str().unwrap(),
        "--out",
        destination.to_str().unwrap(),
    ];
    if check {
        args.push("--check");
    }
    cli(&args)
}

fn write_profile(root: &Path, files: &str) {
    fs::write(
        root.join("profile.json"),
        format!(r#"{{"version":1,"files":{files}}}"#),
    )
    .unwrap();
}

#[test]
fn starter_profiles_are_editable_and_never_overwrite_templates() {
    let staging = tempdir().unwrap();
    for preset in ["fetch", "transport"] {
        let profile = staging.path().join(preset);
        let args = [
            "init",
            "--preset",
            preset,
            "--out",
            profile.to_str().unwrap(),
        ];
        success(cli(&args));
        let original = fs::read_to_string(profile.join("client.jinja")).unwrap();
        fs::write(
            profile.join("client.jinja"),
            format!("// custom\n{original}"),
        )
        .unwrap();
        failure(cli(&args), "starter profile would overwrite");
        let output = staging.path().join("generated").join(preset);
        success(generate(&profile, &output, false));
        assert!(
            fs::read_to_string(output.join("client.ts"))
                .unwrap()
                .starts_with("// custom")
        );
        success(generate(&profile, &output, true));
        assert_eq!(output.join("routes.ts").is_file(), preset == "transport");
    }
}

#[test]
fn generation_checks_drift_without_overwriting_user_files() {
    let staging = tempdir().unwrap();
    let profile = staging.path().join("profile");
    let output = staging.path().join("output");
    fs::create_dir(&profile).unwrap();
    fs::create_dir(&output).unwrap();
    fs::write(
        profile.join("a.jinja"),
        "export const title = {{ api.title | ts_string }};\n",
    )
    .unwrap();
    fs::write(profile.join("b.jinja"), "{{ missing_value }}").unwrap();
    fs::write(output.join("handwritten.ts"), "handwritten\n").unwrap();

    write_profile(&profile, r#"{"a.ts":"a.jinja","b.ts":"b.jinja"}"#);
    failure(generate(&profile, &output, false), "undefined value");
    assert!(!output.join("a.ts").exists());

    write_profile(&profile, r#"{"a.ts":"a.jinja","obsolete.ts":"a.jinja"}"#);
    success(generate(&profile, &output, false));
    success(generate(&profile, &output, true));
    write_profile(&profile, r#"{"a.ts":"a.jinja"}"#);
    failure(generate(&profile, &output, true), "out of date");
    success(generate(&profile, &output, false));
    assert!(!output.join("obsolete.ts").exists());

    fs::write(output.join("a.ts"), "user edits\n").unwrap();
    failure(generate(&profile, &output, true), "out of date");
    failure(generate(&profile, &output, false), "unowned or edited");
    write_profile(&profile, r#"{"handwritten.ts":"a.jinja"}"#);
    failure(generate(&profile, &output, false), "unowned or edited");
    assert_eq!(
        fs::read_to_string(output.join("a.ts")).unwrap(),
        "user edits\n"
    );
    assert_eq!(
        fs::read_to_string(output.join("handwritten.ts")).unwrap(),
        "handwritten\n"
    );
}

#[test]
fn check_does_not_create_missing_output_and_rejects_nonportable_profiles() {
    let staging = tempdir().unwrap();
    let profile = staging.path();
    let output: PathBuf = profile.join("absent");
    write_profile(profile, r#"{"ok.ts":"a.jinja"}"#);
    fs::write(profile.join("a.jinja"), "{{ api.title | ts_string }}\n").unwrap();
    failure(
        generate(profile, &output, true),
        "output directory is missing",
    );
    assert!(!output.exists());

    for (files, message) in [
        (r#"{"../escape.ts":"a.jinja"}"#, "invalid output path"),
        (
            r#"{"A/a.ts":"a.jinja","a/b.ts":"a.jinja"}"#,
            "differ only in casing",
        ),
        (
            r#"{"same.ts":"a.jinja","same.ts":"a.jinja"}"#,
            "duplicate file path",
        ),
        (r#"{"nul.ts":"a.jinja"}"#, "invalid output path"),
        (
            r#"{".quivra-manifest.json":"a.jinja"}"#,
            "reserved output path",
        ),
    ] {
        write_profile(profile, files);
        failure(generate(profile, &output, false), message);
        assert!(!output.exists());
    }
}

#[test]
fn batch_validates_every_document_before_updating_owned_files() {
    let staging = tempdir().unwrap();
    let root = staging.path();
    let output = root.join("out");
    fs::copy("examples/openapi.yaml", root.join("api.yaml")).unwrap();
    fs::write(
        root.join("profile.json"),
        r#"{"version":1,"files":{"client.ts":"client.jinja"},"batchFiles":{"index.ts":"index.jinja"},"serviceFiles":[{"directory":"services","suffix":"Client","template":"service.jinja"}]}"#,
    )
    .unwrap();
    fs::write(root.join("client.jinja"), "{{ api.title }}\n").unwrap();
    fs::write(root.join("service.jinja"), "{{ service.type_name }}\n").unwrap();
    fs::write(
        root.join("index.jinja"),
        "{% for doc in documents %}{{ doc.namespace }}:{{ doc.directory }}\n{% endfor %}",
    )
    .unwrap();
    let batch = root.join("batch.json");
    let mut args = vec![
        "generate-batch",
        batch.to_str().unwrap(),
        "--profile",
        root.to_str().unwrap(),
        "--out",
        output.to_str().unwrap(),
    ];
    let first = r#"{"namespace":"firstApi","directory":"first-api","spec":"api.yaml"}"#;
    let missing = r#"{"namespace":"secondApi","directory":"second-api","spec":"missing.yaml"}"#;
    fs::write(&batch, format!("[{first},{missing}]")).unwrap();
    assert!(!cli(&args).status.success());
    assert!(!output.exists());

    fs::write(&batch, format!("[{first}]")).unwrap();
    success(cli(&args));
    assert_eq!(
        fs::read_to_string(output.join("index.ts")).unwrap(),
        "firstApi:first-api\n"
    );
    assert!(output.join("first-api/client.ts").is_file());
    assert_eq!(
        fs::read_dir(output.join("first-api/services"))
            .unwrap()
            .count(),
        1
    );

    fs::write(&batch, format!("[{first},{missing}]")).unwrap();
    assert!(!cli(&args).status.success());
    assert!(!output.join("second-api").exists());
    fs::write(&batch, format!("[{first}]")).unwrap();
    args.push("--check");
    success(cli(&args));
}
