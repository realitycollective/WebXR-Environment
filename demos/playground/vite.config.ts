import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

// The demo resolves the WORKSPACE libraries to source, so a change to the core
// or the adapter shows up on the next reload with no build step in between.
export default defineConfig({
  resolve: {
    alias: {
      "@realitycollective/webxr-environment": pkg("webxr-environment"),
      "@realitycollective/threejs-environment": pkg("threejs-environment"),
    },
  },
  server: { host: "0.0.0.0", port: 8083 },
  build: { outDir: "dist", target: "esnext" },
});
