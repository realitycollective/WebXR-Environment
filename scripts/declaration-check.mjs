/**
 * Declaration-surface check: prove the PUBLISHED type declarations type-check
 * for a consumer that checks library files.
 *
 * Background. Every repository here builds with `skipLibCheck: true`, as most
 * consumers do, so a declaration file is never type-checked after it is
 * emitted: not ours, not a dependency's. Two kinds of consumer do check it.
 * One sets `skipLibCheck: false`. The other builds a package of its own on
 * top of ours with `declaration: true`, where tsc re-checks every imported
 * declaration in order to emit its own. For both, a `.d.ts` of ours that does
 * not type-check fails their build on the first import of the package, with
 * an error pointing into node_modules.
 *
 * The case that shipped. `@iwsdk/core` 0.5.3 declares `createSystem` as
 * returning a constructor typed on `World`, and the file that says so imports
 * `World` from './world' with no extension. Under NodeNext resolution, which
 * these repositories build with, that import does not resolve, so inside the
 * host's own declaration `World` is an unresolved name. skipLibCheck hid the
 * error, and TypeScript's declaration emitter preserves an unresolved name
 * verbatim, so every exported `class X extends createSystem(...)` shipped
 * with a bare `World` in its base type. The package built green, its tests
 * passed, publint passed, attw passed (it checks that the entry resolves, not
 * what the entry says), and the first consumer with library checking on
 * failed with TS2304.
 *
 * What this checks. Each package's declaration entry - the file its manifest
 * sends a consumer's compiler to - as a root of a strict program with
 * `skipLibCheck: false`, once per module resolution mode a consumer might
 * compile under (nodenext and bundler, which differ on relative imports).
 * A diagnostic inside the package's own directory fails it. A diagnostic
 * anywhere else - a dependency's declarations failing the same strict
 * settings, which `@iwsdk/core` and `@pmndrs/uikit` do by the dozen - is
 * counted for context and otherwise ignored: not ours to fix, and it would
 * drown the signal. Runs in the repository, where the peers are installed,
 * not in the clean consumer verify-pack builds, where they deliberately are
 * not.
 *
 * Where it is worth running, and how you can tell. The fault needs a FOREIGN
 * declaration to reach our emitted types: the build already type-checks every
 * line of our own source, so with nothing but our packages and TypeScript's
 * own lib in the program there is nothing here the build did not already
 * cover. `scripts/release.config.json` therefore opts a repository in with
 * `"declarationCheck": true`, and every run reports how many foreign
 * declaration files it actually pulled in, so that reach is visible rather
 * than assumed. Measured on 2026-09-09: around 950 files from 18 to 21
 * packages in each repository shipping an IWSDK adapter, 3 from React's
 * typings in the Service Framework, and 0 in WebXR-Input, whose architecture
 * test asserts it declares no dependencies of any kind. WebXR-Input is
 * therefore not opted in; a gate that cannot fail is worse than no gate,
 * because it reports a safety it never checked.
 *
 * Library and CLI. This file is identical in every Reality Collective
 * TypeScript repository that opts in; scripts/verify-pack.mjs calls it after
 * publint and attw.
 *
 *   node scripts/declaration-check.mjs              checks release.config.json's packages
 *   node scripts/declaration-check.mjs <dir> ...    checks the given package directories
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The resolution modes checked by default, in the order they are reported. */
export const RESOLUTION_MODES = ['nodenext', 'bundler'];

const MODE_OPTIONS = {
  nodenext: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
  bundler: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler },
};

function manifestOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/**
 * The file a consumer's compiler is sent to for the package's types: the
 * "types" condition of the root export first, then `types`, then `typings`.
 */
function typesEntry(dir, manifest) {
  const root = manifest.exports?.['.'];
  const candidates = [
    typeof root === 'object' && root !== null ? root.types : undefined,
    manifest.types,
    manifest.typings,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const file = path.resolve(dir, candidate);
    if (existsSync(file)) return file;
  }
  return null;
}

function realPath(file) {
  try {
    return realpathSync.native(file);
  } catch {
    // not on disk (a lib file, or a path TypeScript synthesised); use as given
    return file;
  }
}

/**
 * A path in the form TypeScript reports it: symlinks followed, absolute,
 * forward slashes, and case-folded where the file system does not distinguish
 * case. Both sides of every comparison go through here.
 */
function canonical(file) {
  const normalised = path.resolve(realPath(file)).replace(/\\/g, '/');
  return ts.sys.useCaseSensitiveFileNames ? normalised : normalised.toLowerCase();
}

function within(file, dir) {
  return file === dir || file.startsWith(`${dir}/`);
}

/** What a strict consumer compiles with. `types: []` keeps @types packages out, so no repository needs node's typings. */
function consumerOptions(mode) {
  const modeOptions = MODE_OPTIONS[mode];
  if (!modeOptions) {
    throw new Error(`unknown resolution mode "${mode}"; expected one of ${RESOLUTION_MODES.join(', ')}`);
  }
  return {
    ...modeOptions,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    esModuleInterop: true,
    forceConsistentCasingInFileNames: true,
  };
}

function toRecord(diagnostic, relativeTo) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (!diagnostic.file) return { file: '', line: 0, column: 0, code: diagnostic.code, message };
  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
  const file = path.relative(relativeTo, realPath(diagnostic.file.fileName)).replace(/\\/g, '/');
  return { file, line: line + 1, column: character + 1, code: diagnostic.code, message };
}

export function formatDiagnostic(diagnostic) {
  const where = diagnostic.file ? `${diagnostic.file}(${diagnostic.line},${diagnostic.column})` : '(no file)';
  return `${where}: TS${diagnostic.code}: ${diagnostic.message}`;
}

/**
 * Type-check the declaration entry of each package directory, per mode.
 * Every package is a root of the same program, so a sibling reached through
 * node_modules is checked once and its diagnostics land on the sibling.
 */
export function checkDeclarations({ packageDirs, modes = RESOLUTION_MODES }) {
  const packages = packageDirs.map((dir) => {
    const absolute = path.resolve(dir);
    const manifest = manifestOf(absolute);
    const entry = typesEntry(absolute, manifest);
    if (!entry) {
      throw new Error(
        `${manifest.name}: no declaration entry on disk (exports["."].types, types or typings); build the package first`,
      );
    }
    return { name: path.basename(absolute), packageName: manifest.name, dir: absolute, entry, root: canonical(absolute) };
  });

  const result = { typescriptVersion: ts.version, modes: [] };
  for (const mode of modes) {
    const options = consumerOptions(mode);
    const host = ts.createCompilerHost(options, true);
    const program = ts.createProgram({ rootNames: packages.map((pkg) => pkg.entry), options, host });
    const byPackage = new Map(packages.map((pkg) => [pkg, []]));
    const global = [];
    let upstream = 0;

    // How far this run actually reaches. A declaration that is neither ours
    // nor TypeScript's own lib is the only thing that can put a name into our
    // emitted types that our build did not already check. Zero of them means
    // this check cannot fail here.
    let foreignDeclarations = 0;
    for (const file of program.getSourceFiles()) {
      if (program.isSourceFileDefaultLibrary(file)) continue;
      const name = canonical(file.fileName);
      if (!packages.some((pkg) => within(name, pkg.root))) foreignDeclarations += 1;
    }

    for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
      if (!diagnostic.file) {
        global.push(toRecord(diagnostic, process.cwd()));
        continue;
      }
      const file = canonical(diagnostic.file.fileName);
      const owner = packages.find((pkg) => within(file, pkg.root));
      if (owner) byPackage.get(owner).push(toRecord(diagnostic, owner.dir));
      else upstream += 1;
    }
    result.modes.push({
      moduleResolution: mode,
      packages: packages.map((pkg) => ({
        name: pkg.name,
        packageName: pkg.packageName,
        dir: pkg.dir,
        entry: path.relative(pkg.dir, pkg.entry).replace(/\\/g, '/'),
        diagnostics: byPackage.get(pkg),
      })),
      global,
      upstream,
      foreignDeclarations,
    });
  }
  return result;
}

/** The report for every package scripts/release.config.json publishes. */
export function releaseDeclarationReport(modes) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(path.join(scriptDir, 'release.config.json'), 'utf8'));
  const repoRoot = path.resolve(scriptDir, '..');
  return checkDeclarations({
    packageDirs: config.packages.map((name) => path.join(repoRoot, 'packages', name)),
    ...(modes ? { modes } : {}),
  });
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const dirs = process.argv.slice(2);
  const report = dirs.length > 0 ? checkDeclarations({ packageDirs: dirs }) : releaseDeclarationReport();
  console.log(`typescript ${report.typescriptVersion}, library checking on`);
  let failures = 0;
  for (const mode of report.modes) {
    console.log(
      `\n${mode.moduleResolution}: ${mode.foreignDeclarations} foreign declaration file(s) in reach, ${mode.upstream} diagnostic(s) in them, ignored`,
    );
    if (mode.foreignDeclarations === 0) {
      console.log('        note: nothing but our own packages and TypeScript\'s lib are in this program,');
      console.log('        so this check cannot fail here and the build already covers it.');
    }
    for (const diagnostic of mode.global) {
      failures += 1;
      console.log(`  FAIL  ${formatDiagnostic(diagnostic)}`);
    }
    for (const pkg of mode.packages) {
      const ok = pkg.diagnostics.length === 0;
      if (!ok) failures += 1;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${pkg.name}: ${pkg.entry} ${ok ? 'type-checks' : `has ${pkg.diagnostics.length} diagnostic(s)`}`);
      for (const diagnostic of pkg.diagnostics) console.log(`          ${formatDiagnostic(diagnostic)}`);
    }
  }
  process.exit(failures === 0 ? 0 : 1);
}
