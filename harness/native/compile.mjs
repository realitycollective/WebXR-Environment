// Compile the native harness the way the conversion pipeline does, and stop there: bundle entry.ts
// with esbuild (IIFE, ES2020, no browser, no engine), gate the bundle (no three.js or @iwsdk code,
// no browser global outside the host profile), and compile it to Hermes bytecode with the flags the
// pipeline uses, so a bundle the device's engine would refuse fails here. It never runs the bundle:
// a native build runs only on a developer's machine or a headset, never in CI.
// usage: node harness/native/compile.mjs [--require-hermes] [--no-hermes]
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const out = resolve(here, "build/node");
mkdirSync(out, { recursive: true });

// 1. Bundle. Every Reality Collective package resolves to THIS repository's source, so the harness
// proves the working tree, not a published preview.
const pkg = (name) => resolve(root, "packages", name, "src/index.ts");
const outfile = resolve(out, "harness.js");
const result = await build({
  entryPoints: [resolve(here, "entry.ts")],
  bundle: true,
  platform: "neutral",
  format: "iife",
  target: "es2020",
  outfile,
  mainFields: ["module", "main"],
  conditions: ["import", "default"],
  alias: {
    "@realitycollective/webxr-environment": pkg("webxr-environment"),
    "@realitycollective/native-environment": pkg("native-environment"),
  },
  metafile: true,
  logLevel: "warning",
  define: { "process.env.NODE_ENV": '"production"' },
});
const inputs = Object.keys(result.metafile.inputs).map((p) => p.replace(/\\/g, "/"));
const forbidden = inputs.filter((p) => /node_modules\/(three|super-three|@iwsdk|vitest)\//.test(p) || /\/three\/build\//.test(p));
// A test file that imports the test runner drags it into the bundle, and its browser globals with it.
for (const p of inputs) {
  if (/\/test\//.test(p) && !p.includes("node_modules/") && /from\s+["']vitest["']/.test(readFileSync(resolve(root, p), "utf8"))) forbidden.push(p);
}
if (forbidden.length) {
  console.error(`harness: the bundle contains engine code: ${forbidden.join(", ")}`);
  process.exit(1);
}

// 2. The host-profile gate: no browser global named as a free identifier. The prelude reaches the
// shell's objects as properties of globalThis, so `__rcHost` and `__rcShell` never appear bare.
const source = readFileSync(outfile, "utf8");
const browserGlobals = ["window", "document", "navigator", "fetch", "XMLHttpRequest", "requestAnimationFrame", "localStorage", "Intl", "AbortController", "Event", "EventTarget", "MessageChannel", "URL"];
const bare = browserGlobals.filter((name) => new RegExp(`(^|[^.\\w$])${name}\\s*[.(\\[]`, "m").test(source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")));
if (bare.length) {
  console.error(`harness: the bundle names browser globals outside the host profile: ${bare.join(", ")}`);
  process.exit(1);
}
console.log(JSON.stringify({ step: "bundle", bytes: source.length, inputFiles: inputs.length, packages: [...new Set(inputs.map((p) => (p.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/) ?? [])[1]).filter(Boolean))].sort() }));

// 3. Hermes bytecode, when the compiler is installed (npm i -D hermes-compiler): the same flags the
// pipeline uses; a bundle hermesc refuses would refuse on the device.
if (!args.includes("--no-hermes")) {
  const hermesc = findHermesc();
  if (hermesc) {
    const hbc = resolve(out, "harness.hbc");
    execFileSync(hermesc, ["-O", "-Xes6-block-scoping", "-emit-binary", "-out", hbc, outfile], { stdio: ["ignore", "inherit", "pipe"] });
    console.log(JSON.stringify({ step: "hermes", hbc, bytes: readFileSync(hbc).length }));
  } else if (args.includes("--require-hermes")) {
    console.error("harness: hermes-compiler is not installed (npm ci installs it as a devDependency)");
    process.exit(1);
  } else {
    console.log(JSON.stringify({ step: "hermes", skipped: "hermes-compiler is not installed" }));
  }
}

console.log(JSON.stringify({ step: "compiled", bundle: outfile }));

function findHermesc() {
  const candidates = [
    resolve(root, "node_modules/hermes-compiler/hermesc/win64-bin/hermesc.exe"),
    resolve(root, "node_modules/hermes-compiler/hermesc/linux64-bin/hermesc"),
    resolve(root, "node_modules/hermes-compiler/hermesc/osx-bin/hermesc"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}
