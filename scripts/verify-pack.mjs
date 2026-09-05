/**
 * Consumer-path verification: prove the PUBLISHED artifact works.
 *
 * Everything else in these repositories resolves `@realitycollective/...` to
 * `packages/<name>/src` - the demos through Vite aliases, the tests and the
 * typecheck through tsconfig/vitest paths. That is fast and correct for
 * contributors, but it means nothing else ever exercises what a consumer
 * actually installs: the built `dist`, the `exports` map, the `files`
 * allow-list, the `bin` entries and the dependency ranges.
 *
 * This script closes that gap. It packs every package exactly as the publish
 * workflow does - LICENSE and CHANGELOG copied in first - installs the tarballs
 * into a throwaway project outside the repo, and asserts the result is usable.
 * It is the only check that would catch a package which builds green but ships
 * broken.
 *
 * The package set and the smoke tests are read from scripts/release.config.json,
 * so this file is identical in every Reality Collective TypeScript repository.
 *
 * Usage:  npm run verify:pack [-- --skip-build]
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const CONFIG = JSON.parse(readFileSync(path.join(SCRIPT_DIR, 'release.config.json'), 'utf8'));
const PACKAGES = CONFIG.packages;

const skipBuild = process.argv.includes('--skip-build');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const failures = [];

function run(cmd, args, cwd, label) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    const tail = out ? out.split(/\r?\n/).slice(-12).join('\n') : err.message;
    throw new Error(`${label} failed:\n${tail}`);
  }
}

/**
 * Node >= 20 refuses to spawn `npm.cmd` through execFile (the .cmd hardening),
 * so prefer npm's own JS entry point, which npm exports while running a script.
 */
function npmRun(args, cwd, label) {
  const cli = process.env.npm_execpath;
  if (cli && cli.endsWith('.js')) return run(process.execPath, [cli, ...args], cwd, label);
  return run(npm, args, cwd, label);
}

function check(ok, message) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
}

function manifestOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** @realitycollective/webxr-input @ 0.1.0 -> realitycollective-webxr-input-0.1.0.tgz */
function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, '').replace(/\//g, '-')}-${manifest.version}.tgz`;
}

const workdir = mkdtempSync(path.join(tmpdir(), 'rc-verify-'));
const tarballDir = path.join(workdir, 'tarballs');
const consumer = path.join(workdir, 'consumer');

try {
  await mkdir(tarballDir, { recursive: true });
  await mkdir(consumer, { recursive: true });

  if (!skipBuild) {
    console.log('building packages...');
    npmRun(['run', 'build'], ROOT, 'npm run build');
  }

  // The publish workflow copies the shared LICENSE and CHANGELOG into every
  // package before packing; mirror that exactly or this check is not testing
  // what actually ships.
  console.log('packing (as the publish workflow does)...');
  const staged = [];
  for (const name of PACKAGES) {
    for (const file of ['LICENSE', 'CHANGELOG.md']) {
      const src = path.join(ROOT, file);
      const dest = path.join(ROOT, 'packages', name, file);
      if (!existsSync(src) || existsSync(dest)) continue;
      cpSync(src, dest);
      staged.push(dest);
    }
  }
  try {
    for (const name of PACKAGES) {
      const { name: pkgName } = manifestOf(path.join(ROOT, 'packages', name));
      npmRun(
        ['pack', '--workspace', pkgName, '--pack-destination', tarballDir],
        ROOT,
        `npm pack ${name}`,
      );
    }
  } finally {
    for (const dest of staged) rmSync(dest, { force: true });
  }

  const tarballs = PACKAGES.map((name) =>
    path.join(tarballDir, tarballName(manifestOf(path.join(ROOT, 'packages', name)))),
  );

  console.log('installing the tarballs into a clean project...');
  writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'rc-consumer-check', private: true, type: 'module' }, null, 2),
  );
  const installArgs = ['install', ...tarballs];
  // Mirrors the repo .npmrc where one exists (peer clashes npm cannot express).
  if (CONFIG.legacyPeerDeps) installArgs.push('--legacy-peer-deps');
  npmRun(installArgs, consumer, 'npm install (tarballs)');

  console.log('');
  console.log('verifying the installed packages:');
  for (const name of PACKAGES) {
    const source = manifestOf(path.join(ROOT, 'packages', name));
    const dir = path.join(consumer, 'node_modules', ...source.name.split('/'));
    const manifest = manifestOf(dir);

    // every entry point named by main/types/exports must physically exist
    const entries = new Set();
    if (manifest.main) entries.add(manifest.main);
    if (manifest.types) entries.add(manifest.types);
    for (const target of Object.values(manifest.exports ?? {})) {
      if (typeof target === 'string') entries.add(target);
      else for (const value of Object.values(target)) {
        if (typeof value === 'string') entries.add(value);
      }
    }
    for (const rel of entries) {
      check(existsSync(path.join(dir, rel)), `${name}: ${rel} present`);
    }

    // a declared binary with no file behind it installs as a dangling shim
    for (const [bin, rel] of Object.entries(manifest.bin ?? {})) {
      check(existsSync(path.join(dir, rel)), `${name}: bin "${bin}" -> ${rel} present`);
    }

    // a bare "*" range on a sibling only ever resolves inside the workspace
    for (const type of ['dependencies', 'peerDependencies']) {
      for (const [dep, range] of Object.entries(manifest[type] ?? {})) {
        if (dep.startsWith('@realitycollective/')) {
          check(range !== '*', `${name}: ${dep} range "${range}" is publishable (not "*")`);
        }
      }
    }

    // The registry page and the licence terms both come from the tarball. The
    // LICENSE/CHANGELOG assertions apply only where the repository actually has
    // one to stage, so a repo that keeps its history elsewhere still passes.
    check(existsSync(path.join(dir, 'README.md')), `${name}: README shipped`);
    for (const file of ['LICENSE', 'CHANGELOG.md']) {
      if (!existsSync(path.join(ROOT, file))) continue;
      check(existsSync(path.join(dir, file)), `${name}: ${file} shipped`);
    }
  }

  // Packages with no engine peer must import cleanly in plain node - adapters
  // are skipped because their peer (three, @iwsdk/core) is deliberately absent.
  for (const name of CONFIG.importCheck ?? []) {
    const source = manifestOf(path.join(ROOT, 'packages', name));
    const entry = path.join(consumer, 'node_modules', ...source.name.split('/'), 'dist', 'index.js');
    const mod = await import(pathToFileURL(entry).href);
    check(
      Object.keys(mod).length > 0,
      `${name}: imports in plain node (${Object.keys(mod).length} exports)`,
    );
  }

  // a published CLI must launch through its installed bin, not the source tree
  for (const smoke of CONFIG.binSmoke ?? []) {
    const source = manifestOf(path.join(ROOT, 'packages', smoke.package));
    const dir = path.join(consumer, 'node_modules', ...source.name.split('/'));
    const binRel = manifestOf(dir).bin[smoke.bin];
    const out = run(
      process.execPath,
      [path.join(dir, binRel), ...(smoke.args ?? [])],
      consumer,
      `${smoke.bin} smoke`,
    );
    check(
      new RegExp(smoke.match).test(out),
      `${smoke.package}: ${smoke.bin} CLI runs from the installed package`,
    );
  }
} catch (err) {
  console.log('');
  console.log(`  FAIL  ${err.message}`);
  failures.push(err.message);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.error(`verify:pack FAILED - ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('verify:pack passed - the published artifact is consumable.');
