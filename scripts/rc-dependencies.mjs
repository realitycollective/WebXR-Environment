#!/usr/bin/env node
// Which version of another Reality Collective package a change may depend on. Identical in
// every Reality Collective TypeScript repository.
//
// The rule covers @realitycollective packages published from ANOTHER repository, wherever this
// one names them: published packages, demos, harnesses and examples, and every copy
// package-lock.json records.
//
//   into main               the release npm tags `latest`. Never a preview.
//   into any other branch   the newest version on npm, release or preview, whichever is newer.
//
// A range follows the rule when its lowest version IS the target: `^0.1.8` or `0.1.8` for a
// target of 0.1.8. A range that merely admits the target (`^0.1.4`) does not, because the
// lockfile and every consumer's floor stay where the range says.
//
// Packages in THIS repository are stamped by set-version.mjs and linked by the workspace, so
// their ranges are not compared with npm. Into main they must not name a preview either: one
// there means a stamp went wrong.
//
// Every other dependency is out of scope and follows ordinary semver ranges.
//
// usage: node scripts/rc-dependencies.mjs [--into <branch>] [--fix] [--root <dir>]
//   --into   the branch the change is going into. Defaults to the CI context (GITHUB_BASE_REF
//            for a pull request, else GITHUB_REF_NAME), then the checked-out branch.
//   --fix    move every range that is behind its target, regenerate package-lock.json, and
//            check again. A range AHEAD of its target cannot be fixed here: into main it names
//            an unreleased preview, and that repository has to release first.
//   --root   the repository to check. Defaults to the one this script lives in.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCOPE = '@realitycollective/';
const FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.scratch']);

/** A semver version split into its numbers and prerelease identifiers, or null. */
export function parseVersion(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(version).trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence: below zero when `a` comes before `b`. A release outranks its own previews. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${x ? b : a}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The lowest version a range admits, for the forms a dependency on a sibling uses; null otherwise. */
export function rangeFloor(range) {
  const m = /^\s*(\^|~|>=|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(String(range));
  return m ? { operator: m[1] ?? '', version: m[2] } : null;
}

/** The same range with its lowest version moved to `version`: `^0.1.4` -> `^0.1.8`, `0.1.4` -> `0.1.8`. */
export function movedRange(range, version) {
  const floor = rangeFloor(range);
  if (!floor) throw new Error(`cannot move the range '${range}'`);
  return `${floor.operator}${version}`;
}

/** True when a change into `branch` must follow the main rule. Accepts `refs/heads/<name>`. */
export function intoMain(branch) {
  return String(branch ?? '').replace(/^refs\/heads\//, '') === 'main';
}

/**
 * The version a dependency on a package must name. `meta` is npm's document for the package
 * ({ 'dist-tags', versions }), or null when npm has no such package.
 * Returns { version } or { error: 'unpublished' | 'no-release' }.
 */
export function targetVersion(meta, main) {
  if (!meta) return { error: 'unpublished' };
  if (main) {
    const latest = meta['dist-tags']?.latest;
    const parsed = latest ? parseVersion(latest) : null;
    return parsed && !parsed.pre.length ? { version: latest } : { error: 'no-release' };
  }
  const live = Object.entries(meta.versions ?? {})
    .filter(([version, doc]) => parseVersion(version) && !doc?.deprecated)
    .map(([version]) => version)
    .sort(compareVersions);
  return live.length ? { version: live[live.length - 1] } : { error: 'unpublished' };
}

/** Every @realitycollective package name this repository does NOT publish, from its manifests and lockfile. */
export function siblingNames({ manifests, lock }) {
  const local = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const names = new Set();
  for (const { json } of manifests) {
    for (const field of FIELDS) for (const name of Object.keys(json[field] ?? {})) names.add(name);
  }
  for (const key of Object.keys(lock?.packages ?? {})) names.add(lockName(key));
  return [...names].filter((name) => name?.startsWith(SCOPE) && !local.has(name)).sort();
}

function lockName(key) {
  const at = key.lastIndexOf('node_modules/');
  return at === -1 ? null : key.slice(at + 'node_modules/'.length);
}

/**
 * Every place a repository breaks the rule. Pure: the caller reads the repository and npm.
 *   manifests  [{ file, json }], every package.json, `file` relative to the repository root
 *   lock       package-lock.json's contents, or null
 *   registry   Map of package name -> npm's document for it, or null when npm has no such package
 *   into       the branch the change is going into
 * Each violation carries `fixable`: true when --fix can resolve it in this repository.
 */
export function checkRcDependencies({ manifests, lock, registry, into }) {
  const main = intoMain(into);
  const local = new Set(manifests.map((m) => m.json.name).filter(Boolean));
  const targets = new Map();
  const target = (name) => {
    if (!targets.has(name)) targets.set(name, targetVersion(registry.get(name) ?? null, main));
    return targets.get(name);
  };
  const violations = [];

  for (const { file, json } of manifests) {
    for (const field of FIELDS) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (!name.startsWith(SCOPE)) continue;
        const floor = rangeFloor(range);
        if (local.has(name)) {
          if (main && floor && parseVersion(floor.version).pre.length) {
            violations.push({ file, field, name, found: range, reason: 'internal-prerelease', fixable: false });
          }
          continue;
        }
        const t = target(name);
        if (t.error) {
          violations.push({ file, field, name, found: range, reason: t.error, fixable: false });
        } else if (!floor) {
          violations.push({ file, field, name, found: range, expected: `^${t.version}`, reason: 'unreadable-range', fixable: false });
        } else {
          const order = compareVersions(floor.version, t.version);
          if (order < 0) violations.push({ file, field, name, found: range, expected: movedRange(range, t.version), reason: 'behind', fixable: true });
          if (order > 0) violations.push({ file, field, name, found: range, expected: movedRange(range, t.version), reason: 'ahead', fixable: false });
        }
      }
    }
  }

  // The lockfile is what CI installs, so a copy it records counts as much as a range.
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    const name = lockName(key);
    if (!name?.startsWith(SCOPE) || entry.link || local.has(name)) continue;
    const t = target(name);
    if (t.error || entry.version === t.version) continue;
    const parentKey = key.slice(0, key.lastIndexOf('node_modules/')).replace(/\/$/, '');
    const parent = parentKey ? (lockName(parentKey) ?? parentKey) : null;
    // A nested copy exists because its parent's own published range excludes the target. Only a
    // newer parent moves it, so it is not this repository's to fix. A copy AHEAD of the target
    // follows a range that is ahead too, which is reported, and fixed, at the range.
    const behind = parseVersion(entry.version) ? compareVersions(entry.version, t.version) < 0 : true;
    const reason = parent ? 'second-copy' : behind ? 'lock' : 'lock-ahead';
    violations.push({ file: 'package-lock.json', name, found: entry.version, expected: t.version, parent, reason, fixable: reason === 'lock' });
  }
  return { into: String(into ?? ''), main, targets: Object.fromEntries(targets), violations };
}

/** One line saying what is wrong and what to do about it. */
export function formatViolation(v, report) {
  const where = `${v.file}  ${v.name}`;
  const rule = report?.main ? "npm's latest release" : 'the newest version on npm';
  switch (v.reason) {
    case 'behind':
      return `${where} ${v.found} -> ${v.expected}: behind ${rule}. --fix moves it.`;
    case 'ahead':
      return report?.main
        ? `${where} ${v.found}: that version is not released (npm's latest is ${v.expected.replace(/^[\^~=>]+/, '')}). Release ${v.name} first.`
        : `${where} ${v.found}: npm has nothing that new (newest is ${v.expected.replace(/^[\^~=>]+/, '')}). Publish ${v.name} first.`;
    case 'no-release':
      return `${where} ${v.found}: npm has no release of ${v.name} yet, only previews. Release it first.`;
    case 'unpublished':
      return `${where} ${v.found}: ${v.name} is not on npm.`;
    case 'unreadable-range':
      return `${where} '${v.found}': name one lowest version, such as ${v.expected}.`;
    case 'internal-prerelease':
      return `${where} ${v.found}: a package of this repository ranged at a preview, going into main. Re-stamp with set-version.mjs.`;
    case 'lock':
      return `${where} ${v.found} -> ${v.expected}: package-lock.json is behind ${rule}. --fix regenerates it.`;
    case 'lock-ahead':
      return `${where} ${v.found}: package-lock.json holds a version newer than ${v.expected}, because a range asks for it.`;
    case 'second-copy':
      return `${where} ${v.found}: a second copy, required by ${v.parent}, whose range excludes ${v.expected}. Move ${v.parent} to a version that admits it.`;
    default:
      return `${where} ${v.found}: ${v.reason}`;
  }
}

/** Every package.json under `root` (skipping installs and build output) and its package-lock.json. */
export function readRepository(root) {
  const manifests = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.name === 'package.json') {
        manifests.push({ file: path.relative(root, full).split(path.sep).join('/'), json: JSON.parse(readFileSync(full, 'utf8')) });
      }
    }
  };
  walk(root);
  const lockFile = path.join(root, 'package-lock.json');
  return { manifests, lock: existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, 'utf8')) : null };
}

/** npm's document for each name (null when npm has no such package), from the configured registry. */
export async function fetchRegistry(names, registryUrl = process.env.npm_config_registry || 'https://registry.npmjs.org/') {
  const base = registryUrl.endsWith('/') ? registryUrl : `${registryUrl}/`;
  const entries = await Promise.all(
    names.map(async (name) => {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(base + name.replace('/', '%2f'), { headers: { accept: 'application/vnd.npm.install-v1+json' } });
          if (res.status === 404) return [name, null];
          if (!res.ok) throw new Error(`npm answered ${res.status} for ${name}`);
          return [name, await res.json()];
        } catch (error) {
          if (attempt === 3) throw error;
        }
      }
    }),
  );
  return new Map(entries);
}

/** Reads the repository and npm, and checks. */
export async function reportFor(root, into) {
  const repository = readRepository(root);
  const registry = await fetchRegistry(siblingNames(repository));
  return checkRcDependencies({ ...repository, registry, into });
}

// npm on Windows is a .cmd shim, which node only spawns through a shell.
function npm(root, args) {
  const windows = process.platform === 'win32';
  const result = spawnSync(windows ? 'npm.cmd' : 'npm', args, { cwd: root, shell: windows, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`'npm ${args.join(' ')}' exited with code ${result.status}`);
}

/**
 * Moves every range that is behind its target, regenerates package-lock.json, and checks again.
 * Returns the manifests it rewrote (relative to `root`) and the fresh report.
 */
export async function fixRepository(root, into) {
  const before = await reportFor(root, into);
  const changed = new Set();
  const byFile = new Map();
  for (const v of before.violations) {
    if (v.reason === 'behind') byFile.set(v.file, [...(byFile.get(v.file) ?? []), v]);
  }
  for (const [file, moves] of byFile) {
    const full = path.join(root, file);
    let text = readFileSync(full, 'utf8');
    // The same name and range can sit in two fields (dependencies and peerDependencies), so each
    // distinct pair is moved once, everywhere it appears.
    const pairs = new Map(moves.map((v) => [`${JSON.stringify(v.name)}: ${JSON.stringify(v.found)}`, `${JSON.stringify(v.name)}: ${JSON.stringify(v.expected)}`]));
    for (const [from, to] of pairs) {
      if (!text.includes(from)) throw new Error(`${file}: could not find ${from} to move`);
      text = text.replaceAll(from, to);
    }
    writeFileSync(full, text);
    changed.add(file);
  }
  if (changed.size || before.violations.some((v) => v.reason === 'lock')) {
    npm(root, ['install', '--package-lock-only']);
    // A copy only other packages ask for stays where its old lock entry was while that still
    // satisfies them, so the install leaves it behind. Update moves it.
    const stale = (await reportFor(root, into)).violations.filter((v) => v.reason === 'lock').map((v) => v.name);
    if (stale.length) npm(root, ['update', '--package-lock-only', ...new Set(stale)]);
    changed.add('package-lock.json');
  }
  return { changed: [...changed].sort(), report: changed.size ? await reportFor(root, into) : before };
}

function currentBranch(root) {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? null : args[at + 1];
  };
  const root = path.resolve(option('root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const into = option('into') || process.env.GITHUB_BASE_REF || process.env.GITHUB_REF_NAME || currentBranch(root);
  if (!into) {
    console.error('rc-dependencies: name the branch this change goes into with --into <branch>.');
    process.exit(2);
  }
  let report;
  if (args.includes('--fix')) {
    const fixed = await fixRepository(root, into);
    for (const file of fixed.changed) console.log(`moved: ${file}`);
    report = fixed.report;
  } else {
    report = await reportFor(root, into);
  }
  const rule = report.main ? "npm's latest release, no previews" : 'the newest version on npm';
  console.log(`Reality Collective dependencies into '${report.into}': each must name ${rule}.`);
  for (const [name, t] of Object.entries(report.targets)) console.log(`  ${name.padEnd(48)} ${t.version ?? `(${t.error})`}`);
  if (!report.violations.length) {
    console.log('Every one does.');
  } else {
    console.error(`\n${report.violations.length} do not:`);
    for (const v of report.violations) console.error(`  ${formatViolation(v, report)}`);
    process.exit(1);
  }
}
