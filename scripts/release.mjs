#!/usr/bin/env node
// Collapses the several-command release preparation into one. Identical in every
// Reality Collective TypeScript repository; everything that varies by repository
// is read from scripts/release.config.json.
//
//   node scripts/release.mjs status
//       What the working tree carries, whether the packages agree with each other,
//       whether the next tag is free, and what the registry serves. Read-only.
//
//   node scripts/release.mjs prepare [--version X.Y.Z]
//       Cuts release/X.Y.Z from development, drops the preview suffix, regenerates
//       the lockfile, dates the changelog, runs the full gate, then STOPS and asks
//       before it commits, pushes and opens the pull request.
//
// Publishing is NOT here. Both the preview publish and the release publish are the
// "Publish to npm" GitHub Action, dispatched once with dryRun ticked and once
// without, and that already works. This script exists only for the part that was
// eight commands and a pair of hand edits.
//
// Flags:
//   --version X.Y.Z  the release version. Defaults to the version development already
//                    carries with its prerelease suffix dropped (0.1.4-preview.0 -> 0.1.4),
//                    which is what the previous release seeded it with.
//   --yes            answer the confirmation with Y, for an unattended run.
//   --no-gate        skip the local build/typecheck/test/verify:pack gate.
//   --dry-run        do everything local, but never commit, push or open a pull request.
//
// `prepare` asks exactly one question, in the place the runbook puts the manual
// check: after the gate has passed and before anything leaves your machine.
// Answer N and nothing has been pushed - `git checkout development && git branch
// -D release/X.Y.Z` puts the repository back as it was.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const config = JSON.parse(readFileSync(join(scriptDir, "release.config.json"), "utf8"));

const PREID = config.preid ?? "preview";

const argv = process.argv.slice(2);
const command = argv.find((arg) => !arg.startsWith("--")) ?? "status";
const flag = (name) => argv.includes(`--${name}`);
const option = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1];
};

const assumeYes = flag("yes");
const skipGate = flag("no-gate");
const localOnly = flag("dry-run");

const log = (message = "") => console.log(message);
const step = (message) => console.log(`\n== ${message}`);

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

// npm on Windows is a .cmd shim and node refuses to spawn one without a shell.
// git and gh are real executables, so they are spawned directly and their
// arguments are never re-parsed by a shell - which is what makes it safe to pass
// a commit message or a pull request body straight through.
const isWindows = process.platform === "win32";

function exec(cmd, args, { capture = false, allowFail = false, raw = false } = {}) {
  const viaShell = isWindows && (cmd === "npm" || cmd === "npx");
  const result = spawnSync(viaShell ? `${cmd}.cmd` : cmd, args, {
    cwd: root,
    shell: viaShell,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    if (allowFail) return { ok: false, out: "", err: result.error.message };
    fail(`could not run '${cmd}': ${result.error.message}`);
  }
  const ok = result.status === 0;
  if (!ok && !allowFail) {
    if (capture && result.stderr) console.error(result.stderr.trim());
    fail(`'${cmd} ${args.join(" ")}' exited with code ${result.status}.`);
  }
  const out = result.stdout ?? "";
  return { ok, out: raw ? out.replace(/\n$/, "") : out.trim(), err: (result.stderr ?? "").trim() };
}

const git = (...args) => exec("git", args, { capture: true }).out;
const gitTry = (...args) => exec("git", args, { capture: true, allowFail: true });
const gitLive = (...args) => exec("git", args);

async function confirm(question) {
  if (assumeYes) {
    log(`${question} [--yes]`);
    return true;
  }
  if (!process.stdin.isTTY) {
    fail(`${question}\nThere is no terminal to ask on. Re-run with --yes to answer it in advance.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return true;
      if (answer === "" || answer === "n" || answer === "no") return false;
      log("Answer y or n.");
    }
  } finally {
    rl.close();
  }
}

// --- repository state ---------------------------------------------------------

const manifest = (dir) => JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));

function parseVersion(version) {
  const match = String(version).match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) fail(`unparseable version '${version}'.`);
  return {
    prerelease: match[4] ?? null,
    stable: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function repoUrl() {
  const origin = git("remote", "get-url", "origin");
  const ssh = origin.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  return ssh ? `https://${ssh[1]}/${ssh[2]}` : origin.replace(/\.git$/, "");
}

// Every package in the workspace ships one version. A package that has drifted
// means a stamp went wrong, and publishing a mixed set is worse than not publishing.
function requireNoDrift(version) {
  const drifted = config.packages
    .map((dir) => ({ dir, ...manifest(dir) }))
    .filter((pkg) => pkg.version !== version);
  if (drifted.length === 0) return;
  for (const pkg of drifted) log(`  packages/${pkg.dir} carries ${pkg.version}, expected ${version}`);
  fail(`the workspace is not on one version. Re-stamp with 'node scripts/set-version.mjs --set ${version}'.`);
}

function requireCleanTree() {
  const dirty = git("status", "--porcelain");
  if (dirty) {
    log(dirty);
    fail("the working tree has uncommitted changes. A release is cut from what is pushed, not from what is local.");
  }
}

function requireBranch(expected) {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== expected) fail(`this runs from '${expected}', but HEAD is on '${branch}'.`);
}

function requireInSyncWithOrigin(branch) {
  const local = git("rev-parse", "HEAD");
  const remote = gitTry("rev-parse", `origin/${branch}`);
  if (!remote.ok) fail(`origin/${branch} does not exist.`);
  if (local === remote.out) return;
  if (gitTry("merge-base", "--is-ancestor", local, remote.out).ok) {
    fail(`${branch} is behind origin/${branch}. Run 'git pull' and start again.`);
  }
  fail(`${branch} has commits that are not on origin/${branch}. Push them and let CI gate them first.`);
}

function tagExists(tag) {
  if (gitTry("rev-parse", "-q", "--verify", `refs/tags/${tag}`).ok) return "locally";
  if (gitTry("ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`).ok) return "on origin";
  return null;
}

function requireGh() {
  if (!exec("gh", ["--version"], { capture: true, allowFail: true }).ok) {
    fail("the GitHub CLI ('gh') is not on PATH. It is what opens the release pull request.");
  }
  if (!exec("gh", ["auth", "status"], { capture: true, allowFail: true }).ok) {
    fail("'gh' is not authenticated. Run 'gh auth login'.");
  }
}

// --- changelog ----------------------------------------------------------------

const CHANGELOG = join(root, "CHANGELOG.md");

function changelogHeading(version) {
  if (!existsSync(CHANGELOG)) fail("CHANGELOG.md is missing.");
  const text = readFileSync(CHANGELOG, "utf8");
  const pattern = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\][^\\n]*$`, "m");
  if (!pattern.test(text)) {
    fail(
      `CHANGELOG.md has no '## [${version}]' heading. The previews have been accumulating ` +
        `under some heading - add or rename it to [${version}] before releasing.`,
    );
  }
  return pattern;
}

function stampChangelog(version, date) {
  const pattern = changelogHeading(version);
  let text = readFileSync(CHANGELOG, "utf8");

  // "## [X.Y.Z] - YYYY-MM-DD" is the Keep a Changelog form, which every one of
  // these files names in its own header. Some older entries in the estate write
  // the date bare; new ones are written to the standard rather than to the file.
  const dated = `## [${version}] - ${date}`;
  text = text.replace(pattern, dated);

  // Point the reference at the tag this release is about to create. It may be a
  // compare-to-HEAD link, a commits/main link, or missing entirely on a first release.
  const linkPattern = new RegExp(`^\\[${version.replace(/\./g, "\\.")}\\]:.*$`, "m");
  const link = `[${version}]: ${repoUrl()}/releases/tag/v${version}`;
  if (linkPattern.test(text)) {
    text = text.replace(linkPattern, link);
  } else {
    const newest = text.match(/^\[\d+\.\d+\.\d+\]:.*$/m);
    text = newest
      ? text.replace(newest[0], `${link}\n${newest[0]}`)
      : `${text.replace(/\s*$/, "")}\n\n${link}\n`;
  }

  writeFileSync(CHANGELOG, text);
  log(`  ${dated}`);
  log(`  ${link}`);
}

// --- commands -----------------------------------------------------------------

function cmdStatus() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const version = manifest(config.core).version;
  const parsed = parseVersion(version);

  step(`${repoUrl().split("/").pop()} release status`);
  log(`  branch:          ${branch}`);
  log(`  version in tree: ${version}`);
  log(
    parsed.prerelease
      ? `  next release:    ${parsed.stable}   (this preview, with its suffix dropped)`
      : `  next release:    none - this tree carries a stable version, so there is no preview to promote`,
  );

  log("\n  packages:");
  for (const dir of config.packages) {
    const pkg = manifest(dir);
    log(`    ${pkg.name.padEnd(46)} ${pkg.version}${pkg.version === version ? "" : "   <- DRIFTED"}`);
  }

  const tag = `v${parsed.stable}`;
  const where = tagExists(tag);
  log(`\n  tag ${tag}: ${where ? `already exists ${where} - that version is released, pick the next one` : "free"}`);

  step("On the registry");
  for (const dir of config.packages) {
    const { name } = manifest(dir);
    const result = exec("npm", ["view", name, "dist-tags", "--json"], { capture: true, allowFail: true });
    if (!result.ok) {
      log(`  ${name.padEnd(46)} (not on the registry yet)`);
      continue;
    }
    const tags = Object.entries(JSON.parse(result.out || "{}"))
      .map(([distTag, distVersion]) => `${distTag}=${distVersion}`)
      .join("  ");
    log(`  ${name.padEnd(46)} ${tags}`);
  }
}

async function cmdPrepare() {
  step("Preflight");
  requireGh();
  requireCleanTree();
  requireBranch("development");
  gitLive("fetch", "origin", "--tags");
  requireInSyncWithOrigin("development");

  const current = manifest(config.core).version;
  const parsed = parseVersion(current);
  if (!parsed.prerelease) {
    fail(
      `development carries the stable version '${current}'. A release is promoted from a preview; ` +
        `seed one with 'node scripts/set-version.mjs --set <X.Y.Z>-${PREID}.0' first.`,
    );
  }
  requireNoDrift(current);

  const version = option("version") ?? parsed.stable;
  if (parseVersion(version).prerelease) fail(`--version takes a stable version, got '${version}'.`);

  const tag = `v${version}`;
  const where = tagExists(tag);
  if (where) fail(`tag ${tag} already exists ${where}. A published release is never retagged - release the next version.`);

  const branch = `release/${version}`;
  if (gitTry("rev-parse", "-q", "--verify", `refs/heads/${branch}`).ok) {
    fail(`branch ${branch} already exists locally. Finish or delete it before starting again.`);
  }
  if (gitTry("ls-remote", "--exit-code", "--heads", "origin", branch).ok) {
    fail(`branch ${branch} already exists on origin. Its pull request is the release in flight.`);
  }

  // Read the changelog before touching anything, so a missing heading costs
  // nothing rather than leaving a half-stamped branch behind.
  changelogHeading(version);

  log(`  development carries ${current}`);
  log(`  releasing            ${version}`);
  log(`  on branch            ${branch}`);

  step(`Cutting ${branch} and stamping ${version}`);
  gitLive("checkout", "-b", branch);
  exec("node", [join("scripts", "set-version.mjs"), "--set", version]);
  exec("npm", ["install", "--package-lock-only"]);

  step("Dating the changelog");
  stampChangelog(version, new Date().toISOString().slice(0, 10));

  if (skipGate) {
    step("Gate skipped (--no-gate)");
  } else {
    step("Gate: build, typecheck, test, verify:pack");
    exec("npm", ["run", "build"]);
    exec("npm", ["run", "typecheck"]);
    exec("npm", ["test"]);
    exec("npm", ["run", "verify:pack"]);
  }

  step("Ready to release");
  log(exec("git", ["status", "--short"], { capture: true, raw: true }).out);
  log("");
  log(`  ${config.packages.length} package(s) stamped ${version}, changelog dated, lockfile regenerated.`);
  log(`  Nothing has left this machine yet.`);
  log("");
  log("  This is the manual check. Read the diff, and where the repository has a");
  log("  staging deploy or a headset check, do it now.");
  log("");

  if (localOnly) {
    log("  --dry-run: stopping here without committing, pushing or opening a pull request.");
    return;
  }

  if (!(await confirm(`Commit, push ${branch} and open the release pull request into main?`))) {
    log("");
    log("  Stopped. Nothing was pushed. To abandon this release:");
    log(`    git checkout development && git checkout . && git branch -D ${branch}`);
    log("  To finish it later, re-run and answer y, or do it by hand:");
    log(`    git commit -am "chore(release): ${version}" && git push -u origin ${branch}`);
    return;
  }

  step("Committing, pushing and opening the pull request");
  gitLive(
    "add",
    "--",
    "CHANGELOG.md",
    "package-lock.json",
    "README.md",
    ...config.packages.map((dir) => `packages/${dir}/package.json`),
  );
  if (gitTry("diff", "--cached", "--quiet").ok) fail("nothing was staged. The stamp changed no files.");
  gitLive("commit", "-m", `chore(release): ${version}`);
  gitLive("push", "-u", "origin", branch);

  const body = [
    `Release ${version}.`,
    "",
    `- every package stamped \`${version}\` by \`scripts/set-version.mjs\`, internal ranges moved with it`,
    "- `package-lock.json` regenerated against the stamped versions",
    `- \`CHANGELOG.md\` heading dated and its link pointed at \`${tag}\``,
    "",
    "Merging this deploys production where the repository has a Cloudflare project.",
    "Once it has landed, publish from Actions -> Publish to npm, branch `main`:",
    "once with dryRun ticked, then again with it unticked.",
  ].join("\n");
  exec("gh", [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    branch,
    "--title",
    `chore(release): ${version}`,
    "--body",
    body,
  ]);

  step("Next");
  log("  Merge the pull request once CI is green, then publish it the usual way:");
  log("    Actions -> Publish to npm -> branch main, dryRun ticked");
  log("    read the summary, then re-run with dryRun unticked");
  log("  Afterwards, collect the re-seed commit: git checkout development && git pull");
}

const commands = { status: async () => cmdStatus(), prepare: cmdPrepare };

if (!commands[command]) {
  fail(`unknown command '${command}'. Expected one of: ${Object.keys(commands).join(", ")}.`);
}

await commands[command]();
