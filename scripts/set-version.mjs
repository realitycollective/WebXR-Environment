#!/usr/bin/env node
// Sets the version across every publishable workspace package, keeps the
// INTERNAL @realitycollective/* dependency ranges in lockstep, and updates the
// README "Current release" line. Prints ONLY the resulting version to stdout
// (progress goes to stderr) so callers can capture it:
//
//   VERSION="$(node scripts/set-version.mjs --bump)"
//
// Usage:
//   node scripts/set-version.mjs --bump            increment the -<preid>.N counter.
//                                                  A stable X.Y.Z seeds X.Y.(Z+1)-<preid>.0.
//   node scripts/set-version.mjs --set 1.2.3       set an explicit version.
//   [--preid <id>]                                 prerelease id, default "preview".
//
// The package set and the "core" package that carries the canonical version are
// read from scripts/release.config.json, so this file is identical in every
// Reality Collective TypeScript repository.
//
// IMPORTANT: only dependencies on packages that live IN THIS WORKSPACE are
// re-ranged. A dependency on a sibling REPOSITORY's package (for example
// @realitycollective/webxr-input inside WebXR-Interactions) is versioned
// independently and is deliberately left alone.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "..");
const config = JSON.parse(readFileSync(join(scriptDir, "release.config.json"), "utf8"));

const args = process.argv.slice(2);
const preidIdx = args.indexOf("--preid");
const preid = preidIdx !== -1 ? args[preidIdx + 1] : (config.preid ?? "preview");
const setIdx = args.indexOf("--set");
const explicit = setIdx !== -1 ? args[setIdx + 1] : null;
const bump = args.includes("--bump");

if (!bump && !explicit) {
  console.error("Usage: set-version.mjs (--bump | --set <version>) [--preid <id>]");
  process.exit(1);
}

// Bumps the prerelease counter. A stable version rolls to the next patch preview,
// matching the "patch-preview" release scheme:
//   1.0.1-preview.0 -> 1.0.1-preview.1
//   1.0.1           -> 1.0.2-preview.0
function incPrerelease(version, id) {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!m) throw new Error(`Unparseable version: ${version}`);
  const maj = +m[1], min = +m[2], patch = +m[3], pre = m[4];
  if (pre) {
    const pm = pre.match(/^(.*)\.(\d+)$/);
    if (pm && pm[1] === id) return `${maj}.${min}.${patch}-${id}.${+pm[2] + 1}`;
    return `${maj}.${min}.${patch}-${id}.0`;
  }
  return `${maj}.${min}.${patch + 1}-${id}.0`;
}

const manifestPaths = config.packages.map((dir) => join(root, "packages", dir, "package.json"));
const manifests = manifestPaths.map((p) => ({ path: p, json: JSON.parse(readFileSync(p, "utf8")) }));

// The names published FROM this workspace - the only ranges we are allowed to rewrite.
const internalNames = new Set(manifests.map((m) => m.json.name));

const corePath = join(root, "packages", config.core, "package.json");
const coreVersion = JSON.parse(readFileSync(corePath, "utf8")).version;
const target = explicit ?? incPrerelease(coreVersion, preid);
const range = `^${target}`;

for (const { path, json } of manifests) {
  json.version = target;
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const deps = json[field];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      if (internalNames.has(name)) deps[name] = range;
    }
  }
  writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  console.error(`  ${json.name} -> ${target}`);
}

const readmePath = join(root, "README.md");
try {
  const readme = readFileSync(readmePath, "utf8");
  const updated = readme.replace(/Current release: \*\*v[^*]+\*\*/, `Current release: **v${target}**`);
  if (updated !== readme) {
    writeFileSync(readmePath, updated);
    console.error(`  README -> v${target}`);
  }
} catch { /* README is optional */ }

console.error(`Set version: ${coreVersion} -> ${target}`);
process.stdout.write(target + "\n");
