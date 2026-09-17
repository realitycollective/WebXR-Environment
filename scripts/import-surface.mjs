/**
 * Import-surface check: a package may only import a name from a dependency
 * that the dependency exports ITSELF.
 *
 * A package that reaches a name through `export * from '<another package>'`
 * (three.js maths through `@iwsdk/core`, which does `export * from 'three'`)
 * works in node, in TypeScript and in every demo, and then fails the moment a
 * consumer's bundler treats the second package as external: esbuild cannot
 * enumerate a star re-export it is not bundling, so Vite's dependency
 * optimizer stops with `No matching export in "@iwsdk/core" for import
 * "Vector3"`. Nothing in that message names the real cause. The same check
 * refuses a bare import that the package does not declare, because shipped
 * code that resolves a dependency by luck in the monorepo breaks in a
 * consumer's tree.
 *
 * The rules, for every `import { name } from '<package>'` in `src/`:
 *   1. `<package>` is declared in dependencies, peerDependencies or
 *      optionalDependencies (node builtins excepted; type-only imports are
 *      erased and ignored).
 *   2. `name` is in the surface `<package>` defines itself, following its own
 *      relative `export *` chains but never an `export *` from another package.
 *
 * Library and CLI. This file is identical in every Reality Collective
 * TypeScript repository; the per-package test wraps it.
 *
 *   node scripts/import-surface.mjs              checks release.config.json's packages
 *   node scripts/import-surface.mjs <dir> ...    checks the given package directories
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Export-map conditions in the order a browser bundler tries them. */
const CONDITIONS = ['import', 'browser', 'module', 'default'];
const BUILTINS = new Set(builtinModules);
const surfaceCache = new Map();

/** Block comments become blank lines and whole-line comments vanish, so line numbers survive. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ''))
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

/** `{ a, type B, c as d }` -> ['a', 'c'] (type entries are erased at runtime). */
function namedBindings(list) {
  const names = [];
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('type ')) continue;
    names.push(entry.split(/\s+as\s+/)[0].trim());
  }
  return names.filter((name) => /^[\w$]+$/.test(name));
}

/** Exported names after `as`: `{ a as b }` exports `b`. */
function exportedBindings(list) {
  const names = [];
  for (const raw of list.split(',')) {
    const entry = raw.trim();
    if (!entry || entry.startsWith('type ')) continue;
    const parts = entry.split(/\s+as\s+/);
    names.push((parts[1] ?? parts[0]).trim());
  }
  return names.filter((name) => /^[\w$]+$/.test(name));
}

export function packageNameOf(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function isBareSpecifier(specifier) {
  if (!specifier || /^[./]/.test(specifier) || /^[a-z]+:/i.test(specifier) || specifier.startsWith('#')) {
    return false;
  }
  return !BUILTINS.has(specifier);
}

function findPackageDir(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveConditions(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (!CONDITIONS.includes(key)) continue;
      const resolved = resolveConditions(nested);
      if (resolved) return resolved;
    }
  }
  return null;
}

/** undefined: no export map. null: the map exists but denies this subpath. */
function resolveExportsTarget(exportsField, subpath) {
  if (exportsField == null) return undefined;
  if (typeof exportsField === 'string') return subpath === '.' ? exportsField : null;
  const keys = Object.keys(exportsField);
  if (!keys.some((key) => key.startsWith('.'))) {
    return subpath === '.' ? resolveConditions(exportsField) : null;
  }
  if (subpath in exportsField) return resolveConditions(exportsField[subpath]);
  let best = null;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    if (!best || prefix.length > best.prefix.length) best = { key, prefix, suffix };
  }
  if (!best) return null;
  const matched = subpath.slice(best.prefix.length, subpath.length - best.suffix.length);
  const target = resolveConditions(exportsField[best.key]);
  return target ? target.replace(/\*/g, matched) : null;
}

/**
 * The file a bundler would load for `specifier` when imported from `fromDir`.
 * A workspace sibling that has not been built falls back to its TypeScript
 * source, so the check needs no build step.
 */
export function resolveEntry(specifier, fromDir) {
  const name = packageNameOf(specifier);
  const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
  const packageDir = findPackageDir(fromDir, name);
  if (!packageDir) return { packageName: name, reason: 'not installed' };
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  let target = resolveExportsTarget(manifest.exports, subpath);
  if (target === undefined) {
    target = subpath === '.' ? manifest.module || manifest.main || 'index.js' : subpath;
  }
  if (target === null) return { packageName: name, packageDir, reason: `the export map has no entry for "${subpath}"` };
  let entryFile = path.resolve(packageDir, target);
  if (existsSync(entryFile) && statSync(entryFile).isDirectory()) entryFile = path.join(entryFile, 'index.js');
  if (!existsSync(entryFile)) {
    const source = path.join(packageDir, 'src', 'index.ts');
    if (subpath === '.' && existsSync(source)) entryFile = source;
    else return { packageName: name, packageDir, reason: `entry "${target}" is missing` };
  }
  return { packageName: name, packageDir, entryFile, manifest };
}

function resolveRelative(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.js`,
    `${base}.mjs`,
    `${base}.ts`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile()) ?? null;
}

const EXPORT_LIST = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm;
const EXPORT_STAR = /^[ \t]*export\s*\*\s*(?:as\s+([\w$]+)\s+)?from\s*['"]([^'"]+)['"]/gm;
const EXPORT_DECL =
  /^[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function\s*\*?|const|let|var|enum|interface|type|namespace)\s+([\w$]+)/gm;
const EXPORT_DEFAULT = /^[ \t]*export\s+default\b/m;
const ANY_EXPORT = /^[ \t]*export\s/m;
const CJS_EXPORT = /\b(?:module\.exports|exports\.[\w$]+)\s*=/;

/**
 * The names a module defines itself (`names`), following its own relative
 * `export *` chains, and the packages it re-exports wholesale (`externalStars`).
 */
export function moduleSurface(file, seen = new Set()) {
  const key = path.resolve(file);
  if (surfaceCache.has(key)) return surfaceCache.get(key);
  const result = { names: new Set(), externalStars: new Set(), cjs: false };
  if (seen.has(key)) return result;
  seen.add(key);
  const source = stripComments(readFileSync(key, 'utf8'));
  if (!ANY_EXPORT.test(source)) {
    result.cjs = CJS_EXPORT.test(source);
    surfaceCache.set(key, result);
    return result;
  }
  for (const match of source.matchAll(EXPORT_LIST)) {
    if (match[1]) continue;
    for (const name of exportedBindings(match[2])) result.names.add(name);
  }
  for (const match of source.matchAll(EXPORT_DECL)) result.names.add(match[1]);
  if (EXPORT_DEFAULT.test(source)) result.names.add('default');
  for (const match of source.matchAll(EXPORT_STAR)) {
    const [, alias, specifier] = match;
    if (alias) {
      result.names.add(alias);
      continue;
    }
    if (isBareSpecifier(specifier) || BUILTINS.has(specifier)) {
      result.externalStars.add(specifier);
      continue;
    }
    const target = resolveRelative(key, specifier);
    if (!target) continue;
    const nested = moduleSurface(target, seen);
    for (const name of nested.names) result.names.add(name);
    for (const star of nested.externalStars) result.externalStars.add(star);
  }
  surfaceCache.set(key, result);
  return result;
}

function sourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

const IMPORT_LIST = /^[ \t]*import\s+(type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
const REEXPORT_LIST = /^[ \t]*export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
const IMPORT_OTHER = /^[ \t]*import\s+(type\s+)?(?:[\w$]+|\*\s+as\s+[\w$]+)\s*from\s*['"]([^'"]+)['"]/gm;

function declaredPackages(manifest) {
  const names = new Set();
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) names.add(name);
  }
  return names;
}

/**
 * Every rule violation in `<packageDir>/src`. `allow` lists exceptions as
 * `"<specifier>:<name>"`; keep it empty unless a dependency's own layout
 * leaves no honest import path.
 */
export function packageImportViolations(packageDir, { allow = [] } = {}) {
  const root = path.resolve(packageDir);
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = declaredPackages(manifest);
  const allowed = new Set(allow);
  const violations = [];
  const seenUndeclared = new Set();

  for (const file of sourceFiles(path.join(root, 'src'))) {
    const source = stripComments(readFileSync(file, 'utf8'));
    const statements = [];
    for (const match of source.matchAll(IMPORT_LIST)) {
      statements.push({ typeOnly: !!match[1], names: namedBindings(match[2]), specifier: match[3], index: match.index });
    }
    for (const match of source.matchAll(REEXPORT_LIST)) {
      statements.push({ typeOnly: !!match[1], names: namedBindings(match[2]), specifier: match[3], index: match.index });
    }
    for (const match of source.matchAll(IMPORT_OTHER)) {
      statements.push({ typeOnly: !!match[1], names: [], specifier: match[2], index: match.index });
    }
    for (const statement of statements) {
      if (statement.typeOnly || !isBareSpecifier(statement.specifier)) continue;
      const line = lineOf(source, statement.index);
      const packageName = packageNameOf(statement.specifier);
      if (!declared.has(packageName)) {
        const dedupe = `${file}:${packageName}`;
        if (!seenUndeclared.has(dedupe)) {
          seenUndeclared.add(dedupe);
          violations.push({ kind: 'undeclared', file, line, name: null, specifier: statement.specifier, packageName, via: [] });
        }
      }
      if (statement.names.length === 0) continue;
      const resolved = resolveEntry(statement.specifier, root);
      if (!resolved.entryFile) {
        if (declared.has(packageName)) {
          violations.push({ kind: 'unresolvable', file, line, name: null, specifier: statement.specifier, packageName, via: [], reason: resolved.reason });
        }
        continue;
      }
      const surface = moduleSurface(resolved.entryFile);
      if (surface.cjs) continue;
      for (const name of statement.names) {
        if (surface.names.has(name) || allowed.has(`${statement.specifier}:${name}`)) continue;
        violations.push({
          kind: surface.externalStars.size > 0 ? 'star-hop' : 'missing',
          file,
          line,
          name,
          specifier: statement.specifier,
          packageName,
          via: [...surface.externalStars],
        });
      }
    }
  }
  return violations;
}

export function formatViolation(violation, relativeTo = process.cwd()) {
  const where = `${path.relative(relativeTo, violation.file).split(path.sep).join('/')}:${violation.line}`;
  switch (violation.kind) {
    case 'star-hop':
      return `${where}  '${violation.name}' from '${violation.specifier}' is only reachable through export * from ${violation.via.join(', ')}. Import it from the package that defines it and declare that package as a dependency or peer.`;
    case 'missing':
      return `${where}  '${violation.name}' is not exported by '${violation.specifier}'.`;
    case 'undeclared':
      return `${where}  '${violation.packageName}' is imported but not declared in dependencies, peerDependencies or optionalDependencies.`;
    default:
      return `${where}  '${violation.specifier}' could not be resolved: ${violation.reason}.`;
  }
}

/**
 * The report for every package release.config.json publishes, located by
 * walking up from `fromUrl` (a test file's `import.meta.url`) to the
 * directory holding scripts/release.config.json. Keeps node's fs and path
 * out of the tests, which some packages type-check without node's typings.
 */
export function releasePackageReport(fromUrl) {
  let dir = path.dirname(fileURLToPath(fromUrl));
  for (;;) {
    const configFile = path.join(dir, 'scripts', 'release.config.json');
    if (existsSync(configFile)) {
      const { packages } = JSON.parse(readFileSync(configFile, 'utf8'));
      const repoRoot = dir;
      return packages.map((name) => {
        const packageDir = path.join(repoRoot, 'packages', name);
        const violations = packageImportViolations(packageDir).map((violation) => formatViolation(violation, repoRoot));
        return { name, packageDir, violations };
      });
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no scripts/release.config.json above ${fromUrl}`);
    dir = parent;
  }
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptDir, '..');
  let dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    const config = JSON.parse(readFileSync(path.join(scriptDir, 'release.config.json'), 'utf8'));
    dirs = config.packages.map((name) => path.join(repoRoot, 'packages', name));
  }
  let total = 0;
  for (const dir of dirs) {
    const violations = packageImportViolations(dir);
    total += violations.length;
    console.log(`${path.relative(repoRoot, dir) || dir}: ${violations.length === 0 ? 'ok' : `${violations.length} violation(s)`}`);
    for (const violation of violations) console.log(`  ${formatViolation(violation, repoRoot)}`);
  }
  process.exit(total === 0 ? 0 : 1);
}
