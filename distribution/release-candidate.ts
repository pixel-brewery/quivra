import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const commitPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const versionField = /^([ \t]*version[ \t]*=[ \t]*")([^"\r\n]+)("[ \t]*(?:#[^\r\n]*)?)$/mu;
const nameField = /^[ \t]*name[ \t]*=[ \t]*"quivra"[ \t]*(?:#[^\r\n]*)?$/mu;
const manifestPath = "Cargo.toml";
const lockPath = "Cargo.lock";

function git(args: string[], env = process.env): string {
    return execFileSync("git", args, { encoding: "utf8", env });
}

function packageVersion(contents: string, header: string, path: string) {
    const sections = contents.split(/(?=^[ \t]*\[)/mu);
    const matches = sections.filter((section) => section.split(/\r?\n/u, 1)[0]?.trim() === header && nameField.test(section));
    const [section] = matches;
    assert(matches.length === 1 && section !== undefined, `Expected one Quivra package in ${path}.`);
    const version = versionField.exec(section)?.[2];
    assert(version, `Quivra's package has no version in ${path}.`);
    parseVersion(version);
    return {
        version,
        replace: (replacement: string) => sections.map((entry) => entry === section
            ? entry.replace(versionField, (_field: string, prefix: string, _old: string, suffix: string) => `${prefix}${replacement}${suffix}`)
            : entry).join(""),
    };
}

function parseVersion(version: string): readonly [number, number, number] {
    const match = versionPattern.exec(version);
    assert(match?.[0] === version, `Expected a stable package version such as 0.1.2, got ${JSON.stringify(version)}.`);
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    assert([major, minor, patch].every(Number.isSafeInteger), `Package version is out of range: ${version}.`);
    return [major, minor, patch];
}

function requireVersionIncrease(current: string, candidate: string) {
    const [major, minor, patch] = parseVersion(current);
    const [nextMajor, nextMinor, nextPatch] = parseVersion(candidate);
    assert(nextMajor > major || (nextMajor === major && (nextMinor > minor || (nextMinor === minor && nextPatch > patch))),
        `Candidate package version ${candidate} must be greater than ${current}.`);
}

function incrementVersion(current: string, specifier: string): string {
    const [major, minor, patch] = parseVersion(current);
    switch (specifier) {
        case "major": return `${major + 1}.0.0`;
        case "minor": return `${major}.${minor + 1}.0`;
        case "patch": return `${major}.${minor}.${patch + 1}`;
        default: throw new Error(`Expected patch, minor or major, got ${JSON.stringify(specifier)}.`);
    }
}

function verifySource(source: string) {
    assert(commitPattern.test(source) && git(["rev-parse", "HEAD"]).trim() === source,
        "Candidate checkout must be at the exact source commit.");
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=no"]), "", "Candidate checkout has tracked changes.");
}

function readPackageFiles(commit: string) {
    const manifest = git(["show", `${commit}:${manifestPath}`]);
    const lock = git(["show", `${commit}:${lockPath}`]);
    const manifestPackage = packageVersion(manifest, "[package]", manifestPath);
    const lockedPackage = packageVersion(lock, "[[package]]", lockPath);
    assert.equal(lockedPackage.version, manifestPackage.version, "Quivra's manifest and lockfile versions differ.");
    return { manifest, lock, manifestPackage, lockedPackage };
}

async function prepareCandidate(directory: string, source: string, specifier: string, requested: string | undefined) {
    assert.equal(process.env.GITHUB_ACTIONS, "true", "Prepare release candidates in GitHub Actions.");
    verifySource(source);
    const { manifestPackage, lockedPackage } = readPackageFiles(source);
    const defaultVersion = incrementVersion(manifestPackage.version, specifier || "patch");
    const version = requested || defaultVersion;
    requireVersionIncrease(manifestPackage.version, version);

    await mkdir(directory, { recursive: true });
    git(["checkout", "--detach", source]);
    await writeFile(manifestPath, manifestPackage.replace(version));
    await writeFile(lockPath, lockedPackage.replace(version));
    git(["add", "--", manifestPath, lockPath]);
    const date = git(["show", "--no-patch", "--format=%cI", source]).trim();
    git([
        "-c", "user.name=github-actions[bot]",
        "-c", "user.email=41898282+github-actions[bot]@users.noreply.github.com",
        "commit", "--no-gpg-sign", "-m", `chore(release): ${version} [skip ci]`,
    ], { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });

    const commit = git(["rev-parse", "HEAD"]).trim();
    git(["bundle", "create", join(directory, "candidate.bundle"), "HEAD", `^${source}`]);
    return { version, commit };
}

async function importCandidate(directory: string, source: string, commit: string) {
    verifySource(source);
    assert(commitPattern.test(commit), "Expected the exact release candidate commit ID.");
    const bundle = join(directory, "candidate.bundle");
    assert.equal(git(["bundle", "list-heads", bundle]).trim(), `${commit} HEAD`, "Bundle must advertise only the expected release commit.");
    git(["fetch", "--no-tags", "--no-write-fetch-head", bundle, "HEAD"]);
    assert.equal(git(["rev-list", "--parents", "-1", commit]).trim(), `${commit} ${source}`,
        "Release candidate must be a single commit based on the expected source.");
    assert.deepEqual(git(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", source, commit]).split("\0").filter(Boolean).sort(),
        [lockPath, manifestPath].sort(), "Release candidate must change only Cargo package version files.");
    assert.equal(git(["diff", "--summary", source, commit]), "", "Release candidate changed file modes or added or removed files.");

    const original = readPackageFiles(source);
    const candidate = readPackageFiles(commit);
    const version = candidate.manifestPackage.version;
    requireVersionIncrease(original.manifestPackage.version, version);
    assert.equal(candidate.manifest, original.manifestPackage.replace(version), "Candidate Cargo.toml must change only Quivra's version.");
    assert.equal(candidate.lock, original.lockedPackage.replace(version), "Candidate Cargo.lock must change only Quivra's version.");
    git(["checkout", "--detach", commit]);
    return { version, commit };
}

const [command, directory, source, argument, requested, ...extra] = process.argv.slice(2);
if (command === "prepare" && directory && source && extra.length === 0) {
    console.log(JSON.stringify(await prepareCandidate(resolve(directory), source, argument ?? "patch", requested)));
} else if (command === "import" && directory && source && argument && requested === undefined) {
    console.log(JSON.stringify(await importCandidate(resolve(directory), source, argument)));
} else {
    throw new Error("Usage: node distribution/release-candidate.ts prepare DIRECTORY SOURCE_SHA [patch|minor|major] [VERSION]\n"
        + "       node distribution/release-candidate.ts import DIRECTORY SOURCE_SHA RELEASE_COMMIT");
}
