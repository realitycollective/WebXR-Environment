/**
 * Architectural gate: the environment core must stay engine-free, and unlike
 * its sibling cores it must depend on NOTHING AT ALL.
 *
 * That second assertion is the important one. An environment package is
 * exactly where a well-meaning shortcut - "just read the session to know about
 * passthrough", "just take the input contracts, they are already there" -
 * turns a leaf into a hub. Passthrough arrives through `setPassthrough`
 * precisely so that this test can stay this strict.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const FORBIDDEN = [
  "'@iwsdk/",
  '"@iwsdk/',
  "'three'",
  '"three"',
  "'@pmndrs/",
  '"@pmndrs/',
  "'super-three",
  "'xrblocks",
  '"xrblocks',
  "'@babylonjs/",
  '"@babylonjs/',
];

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("engine-free package", () => {
  it("src/ imports no engine packages anywhere", () => {
    const files = tsFiles(SRC);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const marker of FORBIDDEN) {
        expect(
          source.includes(`from ${marker}`) || source.includes(`import ${marker}`),
          `${file} must not import ${marker}`,
        ).toBe(false);
      }
    }
  });

  it("has no runtime dependencies at all", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it("does not reach for the platform layer's concerns", () => {
    // Sessions, capabilities and input are other packages' jobs. A grep is a
    // blunt instrument, but it fails loudly the moment someone imports one of
    // them "just for a type", which is how these boundaries actually erode.
    for (const file of tsFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      expect(source.includes("navigator.xr"), `${file} must not read navigator.xr`).toBe(false);
      expect(
        source.includes("@realitycollective/service-framework"),
        `${file} must not depend on the service framework`,
      ).toBe(false);
      expect(
        source.includes("@realitycollective/webxr-input"),
        `${file} must not depend on the input contracts`,
      ).toBe(false);
    }
  });
});

describe("no sibling package is referenced anywhere, including in tests", () => {
  // The estate is decoupled, and a decoupled estate does not survive a package
  // that merely KNOWS the shape of another. An earlier draft of this one had a
  // test reproducing the interaction core's audio-sink signatures verbatim to
  // prove compatibility - no import, no dependency, and still wrong: it made a
  // sibling's API something this repository had to track, and it invited the
  // convenience adapter that would have made the coupling real.
  //
  // So the rule is checked over `test/` as well as `src/`: what crosses a
  // boundary crosses it as a subscription the APP makes, and nothing in here
  // is entitled to an opinion about what is on the other end.
  const SIBLINGS = [
    "@realitycollective/webxr-interactions",
    "@realitycollective/iwsdk-interactions",
    "@realitycollective/threejs-interactions",
    "@realitycollective/webxr-uiextensions",
    "@realitycollective/iwsdk-uiextensions",
    "FeedbackAudioSink",
    "FeedbackIntent",
    "routeAudioToSink",
  ];

  it("holds for src/ and test/ alike", () => {
    const files = [
      ...tsFiles(SRC),
      ...tsFiles(fileURLToPath(new URL("../test", import.meta.url))),
    ];
    for (const file of files) {
      // This file names them to forbid them; everything else may not.
      if (file.endsWith("architecture.test.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const sibling of SIBLINGS) {
        expect(source.includes(sibling), `${file} must not reference ${sibling}`).toBe(false);
      }
    }
  });
});
