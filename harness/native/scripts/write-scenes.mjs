// Write harness/native/scenes/*.iwsdk.scene.json from the tour's layout (src/tour-layout.ts), so the
// native host places the same parts the cook produced from scene-assets.ts.
// Run after changing the layout: npm run harness:scenes
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "../../..");
const out = resolve(here, "../build/scene");
mkdirSync(out, { recursive: true });
const bundle = resolve(out, "layout.cjs");
await build({
  entryPoints: [resolve(root, "harness/native/src/tour-layout.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "es2022",
  outfile: bundle,
  logLevel: "warning",
});
const layout = createRequire(import.meta.url)(bundle);

const round = (n) => Number(n.toFixed(5));
const scenesDir = resolve(here, "../scenes");
mkdirSync(scenesDir, { recursive: true });

for (const scene of layout.TOUR_SCENES) {
  const doc = {
    version: "iwsdk.scene.v1",
    units: "meters",
    metadata: {
      "com.realitycollective.environment-harness": `The Environment harness tour scene "${scene.id}", generated from harness/native/src/tour-layout.ts by harness/native/scripts/write-scenes.mjs.`,
    },
    resources: {},
    nodes: scene.parts.map((part) => ({
      id: part.name,
      name: part.name,
      transform: { position: part.position.map(round) },
      content: { type: "asset", asset: part.name },
    })),
  };
  const target = resolve(scenesDir, scene.file);
  writeFileSync(target, JSON.stringify(doc, null, 2) + "\n");
  console.log(JSON.stringify({ step: "scene", file: target, nodes: doc.nodes.length }));
}
