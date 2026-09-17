/**
 * Consumer prebundle check: prove a package survives a dev server's dependency
 * optimizer, on EVERY bundler we claim to support, and prove the check itself
 * can still fail.
 *
 * Background. Every demo in these repositories aliases the packages to their
 * source, so nothing here is ever prebundled the way a consumer prebundles it:
 * built output, reached through node_modules, bundled next to the host engine.
 * That is the path on which a name imported through another package's
 * `export *` fails, and it fails only when the host engine is itself an
 * optimizer entry and the star's source is external to the optimizer.
 *
 * Why this runs more than once. The fault is BUNDLER-SPECIFIC, not universal.
 * Vite 7 optimizes with esbuild, which demands that every named import be
 * statically enumerable and so rejects a name behind an external `export *`.
 * Vite 8 optimizes with rolldown, which resolves the same import lazily
 * through a namespace object and accepts it. Both are correct; they differ in
 * strictness. So a check that runs on one bundler tells you nothing about
 * consumers on the other, and a check that runs only on the permissive one is
 * decorative. `scripts/release.config.json` names the bundlers to test.
 *
 * Why it checks itself. A gate that can only pass is worse than no gate,
 * because it reports safety it cannot verify. Each run therefore also feeds the
 * optimizer a DELIBERATELY BROKEN copy of the package - one extra module
 * importing a name the host only re-exports wholesale - and records whether the
 * bundler rejected it. That is compared against the expectation declared in the
 * config, so the day a bundler's strictness changes, in either direction, this
 * says so instead of quietly passing forever.
 *
 * Dependencies. Transpiling uses the TypeScript compiler this repository
 * already builds with, not a bundler's own transpiler, so no bundler is a
 * hidden requirement of the harness. The only bundlers loaded are the ones the
 * config names, installed under npm aliases (`vite-7`, `vite-8`), which is the
 * same mechanism the workspace uses for `three`.
 *
 * This file is identical in every Reality Collective TypeScript repository that
 * ships an engine adapter; the per-package test wraps it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { moduleSurface, resolveEntry } from './import-surface.mjs';

const CANARY_MODULE = '__star-hop-canary.js';
const CANARY_INDEX = '__with-canary.js';

function manifestOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Transpile `<packageDir>/src` to plain ESM, mirroring the layout. TypeScript's
 * own transpiler is used with `verbatimModuleSyntax`, so import statements
 * survive exactly as `tsc` emits them: type-only specifiers dropped, every
 * value import left alone. That fidelity is the whole point, because the import
 * statement IS what is under test.
 */
function transpilePackage(packageDir, outDir) {
  const srcDir = path.join(packageDir, 'src');
  for (const file of sourceFiles(srcDir)) {
    const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true,
        isolatedModules: true,
      },
    });
    const target = path.join(outDir, path.relative(srcDir, file)).replace(/\.(ts|tsx|mts)$/, '.js');
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, outputText);
  }
}

/**
 * A name the host exports ONLY by re-exporting another package wholesale, and
 * the package that really defines it. This is the shape of import that broke a
 * consumer, discovered rather than hard-coded, so the canary stays valid as the
 * host's surface changes. `null` means the host re-exports nothing wholesale,
 * in which case the hazard has structurally gone away.
 */
function findStarHopName(hostEntryFile, fromDir) {
  const host = moduleSurface(hostEntryFile);
  for (const star of host.externalStars) {
    const resolved = resolveEntry(star, fromDir);
    if (!resolved.entryFile) continue;
    const starred = moduleSurface(resolved.entryFile);
    if (starred.cjs) continue;
    for (const name of starred.names) {
      if (!host.names.has(name) && /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') {
        return { name, via: star };
      }
    }
  }
  return null;
}

function optimizerErrors(error) {
  const text = String(error && error.message ? error.message : error).replace(/\x1b\[[0-9;]*m/g, '');
  const lines = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /No matching export|not exported|\[ERROR\]/.test(line)),
    ),
  ];
  return lines.length > 0 ? lines : [text.slice(0, 600)];
}

/**
 * Run one bundler's dependency optimizer over `entryFile`, published under
 * `packageName`, with `exclude` external to the optimizer.
 *
 * `quiet` also silences the underlying bundler's own diagnostics, which is used
 * for the canary run. That run fails ON PURPOSE, and esbuild prints from a
 * child process straight to the inherited file descriptor, so it cannot be
 * captured inside this process: left on, a deliberate failure lands in the
 * middle of a green test run looking exactly like a real one. Nothing is lost,
 * because the messages still arrive on the thrown error and are reported
 * through the result's `errors`.
 */
async function optimize(vite, { root, packageName, entryFile, hostEntries, alias, exclude, cacheDir, quiet }) {
  const config = await vite.resolveConfig(
    {
      root,
      configFile: false,
      logLevel: 'silent',
      cacheDir,
      resolve: { alias: { ...alias, [packageName]: entryFile } },
      optimizeDeps: {
        include: [...hostEntries, packageName],
        exclude,
        // Vite 7 optimizes with esbuild and Vite 8 with rolldown, so the two
        // take their bundler options under different keys. Setting both is
        // harmless: each version ignores the one it does not own.
        ...(quiet
          ? { esbuildOptions: { logLevel: 'silent' }, rollupOptions: { logLevel: 'silent' } }
          : {}),
      },
    },
    'serve',
  );
  try {
    await vite.optimizeDeps(config, true, true);
    return { ok: true, errors: [] };
  } catch (error) {
    return { ok: false, errors: optimizerErrors(error) };
  }
}

/**
 * @param {object} options
 * @param {string} options.repoRoot        repository root, holding node_modules and packages/
 * @param {string} options.packageDir      the package under test
 * @param {string[]} options.hostEntries   packages the application imports directly, e.g. ['@iwsdk/core']
 * @param {{id: string, package: string}} options.bundler  the bundler to load, from release.config.json
 * @param {string[]} [options.exclude]     packages to exclude from optimization; defaults to every
 *                                         package the host entries re-export wholesale
 */
export async function prebundleCheck({ repoRoot, packageDir, hostEntries, bundler, exclude }) {
  const root = path.resolve(repoRoot);
  const pkg = path.resolve(packageDir);
  const packageName = manifestOf(pkg).name;

  const vite = await import(bundler.package);
  const viteVersion = manifestOf(path.join(root, 'node_modules', bundler.package)).version;

  const cacheRoot = path.join(
    root,
    'node_modules',
    '.cache',
    'rc-prebundle',
    `${packageName.replace(/[@/]/g, '_')}.${bundler.id}`,
  );
  rmSync(cacheRoot, { recursive: true, force: true });
  mkdirSync(cacheRoot, { recursive: true });

  const transpiled = path.join(cacheRoot, 'pkg');
  transpilePackage(pkg, transpiled);

  // What a consumer excludes when it needs to transform one of these packages.
  let excluded = exclude;
  const stars = [];
  for (const host of hostEntries) {
    const resolved = resolveEntry(host, pkg);
    if (!resolved.entryFile) throw new Error(`${host} could not be resolved from ${pkg}: ${resolved.reason}`);
    for (const star of moduleSurface(resolved.entryFile).externalStars) {
      if (!stars.includes(star)) stars.push(star);
    }
  }
  if (!excluded) excluded = stars;

  // The broken twin: the real package plus one module importing a name the host
  // only provides by re-exporting another package wholesale.
  const hostEntry = resolveEntry(hostEntries[0], pkg);
  const starHop = hostEntry.entryFile ? findStarHopName(hostEntry.entryFile, pkg) : null;
  if (starHop) {
    writeFileSync(
      path.join(transpiled, CANARY_MODULE),
      `import { ${starHop.name} } from '${hostEntries[0]}';\nexport const starHopProbe = ${starHop.name};\n`,
    );
    writeFileSync(
      path.join(transpiled, CANARY_INDEX),
      `export * from './index.js';\nexport * from './${CANARY_MODULE}';\n`,
    );
  }

  const consumer = path.join(cacheRoot, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'index.html'), '<!doctype html><script type="module" src="/main.js"></script>\n');
  const imports = [...hostEntries, packageName].map((name, i) => `import * as m${i} from '${name}';`);
  writeFileSync(
    path.join(consumer, 'main.js'),
    `${imports.join('\n')}\nconsole.log(${imports.map((_, i) => `m${i}`).join(', ')});\n`,
  );

  // Workspace siblings resolve to their sources, so no build step is needed.
  const alias = {};
  const packagesDir = path.join(root, 'packages');
  if (existsSync(packagesDir)) {
    for (const dir of readdirSync(packagesDir)) {
      const siblingDir = path.join(packagesDir, dir);
      const source = path.join(siblingDir, 'src', 'index.ts');
      if (siblingDir === pkg || !existsSync(path.join(siblingDir, 'package.json')) || !existsSync(source)) continue;
      alias[manifestOf(siblingDir).name] = source;
    }
  }

  const shared = { root: consumer, packageName, hostEntries, alias };
  const run = (entryFile, excludeList, cacheName, quiet = false) =>
    optimize(vite, {
      ...shared,
      entryFile,
      exclude: excludeList,
      cacheDir: path.join(consumer, `.vite-${cacheName}`),
      quiet,
    });

  try {
    const realEntry = path.join(transpiled, 'index.js');
    const control = await run(realEntry, [], 'control');
    const withExternals = await run(realEntry, excluded, 'excluded');
    let canary = { available: false, detected: null, via: null, name: null, errors: [] };
    if (starHop) {
      const broken = await run(path.join(transpiled, CANARY_INDEX), excluded, 'canary', true);
      canary = {
        available: true,
        detected: !broken.ok,
        via: starHop.via,
        name: starHop.name,
        errors: broken.errors,
      };
    }
    return {
      bundler: bundler.id,
      bundlerPackage: bundler.package,
      viteVersion,
      exclude: excluded,
      stars,
      control,
      excluded: withExternals,
      canary,
    };
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}

/**
 * The prebundle plan for the package a test file sits in: the repository root,
 * the package directory, the host packages to bundle it next to, and the
 * bundlers to test. Read from scripts/release.config.json by walking up from
 * `fromUrl`, so the test itself imports nothing from node.
 */
export function prebundlePlan(fromUrl) {
  let dir = path.dirname(fileURLToPath(fromUrl));
  let packageDir = null;
  for (;;) {
    if (!packageDir && existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src'))) {
      packageDir = dir;
    }
    const configFile = path.join(dir, 'scripts', 'release.config.json');
    if (existsSync(configFile)) {
      if (!packageDir) throw new Error(`no package directory found above ${fromUrl}`);
      const config = JSON.parse(readFileSync(configFile, 'utf8'));
      const prebundle = config.prebundle ?? {};
      const name = path.basename(packageDir);
      const entry = (prebundle.packages ?? {})[name];
      if (!entry) throw new Error(`scripts/release.config.json has no prebundle.packages entry for "${name}"`);
      return {
        repoRoot: dir,
        packageDir,
        hostEntries: entry.hosts,
        bundlers: prebundle.bundlers ?? [],
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`no scripts/release.config.json above ${fromUrl}`);
    dir = parent;
  }
}
