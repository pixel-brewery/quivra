import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-candidate.ts", import.meta.url));
const manifest = '[package]\r\nname = "quivra"\r\nversion = "0.1.1" # baseline\r\nedition = "2024"\r\n\r\n[dependencies]\r\n';
const lock = 'version = 4\n\n[[package]]\nname = "dependency"\nversion = "0.1.1"\n\n[[package]]\nname = "quivra"\nversion = "0.1.1"\n';
const env = {
    ...process.env,
    GITHUB_ACTIONS: "true",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function sourceCheckout(cwd: string) {
    await mkdir(cwd);
    git(cwd, "init", "--initial-branch=main", "--object-format=sha1");
    git(cwd, "config", "user.name", "Quivra Test");
    git(cwd, "config", "user.email", "test@example.invalid");
    git(cwd, "config", "core.autocrlf", "false");
    await writeFile(join(cwd, "Cargo.toml"), manifest);
    await writeFile(join(cwd, "Cargo.lock"), lock);
    git(cwd, "add", "--", "Cargo.toml", "Cargo.lock");
    git(cwd, "commit", "--no-gpg-sign", "-m", "feat: track the package manifest");
    return git(cwd, "rev-parse", "HEAD");
}

function candidate(cwd: string, ...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: "utf8" });
}

function candidateResult(result: ReturnType<typeof candidate>): { version: string; commit: string } {
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
}

test("transfers a version-only candidate into a separate checkout of its source", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "quivra candidate "));
    context.after(() => rm(root, { force: true, recursive: true }));
    const producer = join(root, "producer");
    const consumer = join(root, "consumer");
    const artifact = join(root, "artifacts");
    const source = await sourceCheckout(producer);
    assert.equal(await sourceCheckout(consumer), source);

    const prepared = candidateResult(candidate(producer, "prepare", artifact, source));
    assert.equal(prepared.version, "0.1.2");
    assert.equal(git(producer, "rev-parse", "main"), source);
    assert.equal(git(producer, "show", "-s", "--format=%s", prepared.commit), "chore(release): 0.1.2 [skip ci]");
    assert.deepEqual(candidateResult(candidate(consumer, "import", artifact, source, prepared.commit)), prepared);
    assert.equal(git(consumer, "rev-parse", "HEAD"), prepared.commit);
    assert.equal(git(consumer, "rev-parse", "main"), source);
    assert.equal(git(consumer, "branch", "--show-current"), "");
    assert.equal(await readFile(join(consumer, "Cargo.toml"), "utf8"), manifest.replace("0.1.1", "0.1.2"));
    assert.equal(await readFile(join(consumer, "Cargo.lock"), "utf8"), lock.replace(/0\.1\.1"\n$/u, '0.1.2"\n'));
});

test("rejects non-increasing versions and bundle changes to package metadata", async (context) => {
    const root = await mkdtemp(join(tmpdir(), "quivra candidate "));
    context.after(() => rm(root, { force: true, recursive: true }));
    const producer = join(root, "producer");
    const consumer = join(root, "consumer");
    const artifact = join(root, "artifacts");
    const source = await sourceCheckout(producer);
    assert.equal(await sourceCheckout(consumer), source);

    const invalidVersion = candidate(producer, "prepare", artifact, source, "patch", "0.1.0");
    assert.notEqual(invalidVersion.status, 0);
    assert.match(invalidVersion.stderr, /must be greater/u);
    assert.equal(git(producer, "rev-parse", "HEAD"), source);
    assert.equal(git(producer, "status", "--porcelain"), "");

    const prepared = candidateResult(candidate(producer, "prepare", artifact, source, "minor"));
    assert.equal(prepared.version, "0.2.0");
    const manifestPath = join(producer, "Cargo.toml");
    await writeFile(manifestPath, (await readFile(manifestPath, "utf8")).replace("2024", "2021"));
    git(producer, "add", "--", "Cargo.toml");
    git(producer, "commit", "--amend", "--no-edit", "--no-gpg-sign");
    const tampered = git(producer, "rev-parse", "HEAD");
    git(producer, "bundle", "create", join(artifact, "candidate.bundle"), "HEAD", `^${source}`);

    const invalidBundle = candidate(consumer, "import", artifact, source, tampered);
    assert.notEqual(invalidBundle.status, 0);
    assert.match(invalidBundle.stderr, /must change only Quivra's version/u);
    assert.equal(git(consumer, "rev-parse", "HEAD"), source);
    assert.equal(git(consumer, "status", "--porcelain"), "");
});
