import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@realitycollective/webxr-environment": pkg("webxr-environment"),
      "@realitycollective/threejs-environment": pkg("threejs-environment"),
      "@realitycollective/iwsdk-environment": pkg("iwsdk-environment"),
    },
  },
  test: {
    globals: true,
    include: ["packages/*/test/**/*.test.ts", "demos/*/test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      all: true,
      // EVERY package, adapters included. An adapter that is not measured is
      // an adapter whose defects ship - which is how the sibling repository
      // lost a desktop-input path with healthy-looking numbers.
      include: ["packages/*/src/**/*.ts"],
      // Files with NO executable code: pure `interface` / `type` declarations
      // and barrel re-exports. Types are erased before anything runs, so v8
      // scores them 0% forever and they drag the totals down while hiding
      // nothing. Listed one by one rather than by a `**/index.ts` glob, so an
      // index file that later grows real logic starts being measured instead
      // of quietly staying exempt.
      exclude: [
        "packages/webxr-environment/src/ports.ts",
        "packages/webxr-environment/src/index.ts",
        "packages/threejs-environment/src/index.ts",
        "packages/iwsdk-environment/src/index.ts",
      ],
      // Anti-regression ratchets, one per package, each at the floor that
      // package actually measures today. Per-package rather than one global
      // number on purpose: a single workspace figure would let the core slide
      // to the average without failing anything. Raise these as suites fill
      // in; never lower them.
      thresholds: {
        // Applies to any package added later with no ratchet of its own.
        lines: 90,
        branches: 85,
        functions: 90,
        statements: 90,

        // The engine-free core. Nothing in it needs a browser, a renderer or a
        // headset, so the house standard applies with no excuses available.
        // Every statement, line and function is exercised; the branches left
        // are `??` defaults on optional spec fields.
        "packages/webxr-environment/src/**": {
          lines: 100,
          branches: 98,
          functions: 100,
          statements: 100,
        },
        // three.js imports headlessly in node, so both ports run against a real
        // Scene and a real AudioListener over a structural Web Audio context.
        // What no unit test can reach is the WebGL side - which is also the one
        // part three.js itself is responsible for.
        "packages/threejs-environment/src/**": {
          lines: 100,
          branches: 96,
          functions: 100,
          statements: 100,
        },
        // @iwsdk/core also imports headlessly, so the ports run against REAL
        // component definitions with only the world and its entities faked. A
        // fake that also faked `DomeGradient` would let a misspelled field name
        // through, which is the defect an adapter is most likely to have.
        "packages/iwsdk-environment/src/**": {
          lines: 100,
          branches: 97,
          functions: 100,
          statements: 100,
        },
      },
    },
  },
});
