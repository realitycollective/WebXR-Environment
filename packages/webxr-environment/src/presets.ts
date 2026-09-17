/**
 * EXAMPLE environments, and the helper that makes fog transitions behave.
 *
 * These are ordinary `EnvironmentSpec` literals with no privileged status.
 * They exist so a new project has something to look at in its first five
 * minutes and so the README has something concrete to point at - not because
 * this package has an opinion about how anyone's world should look. ART
 * DIRECTION IS THE APP'S. Copy one and edit it rather than layering overrides
 * on it forever, and delete the import once your own presets exist.
 */
import type { EnvironmentSpec, FogSpec } from "./environment.js";
import { rgbFromHex } from "./math.js";

/** Nothing at all: black, unlit, empty. The starting point of a void scene. */
export const VOID: EnvironmentSpec = {
  sky: null,
  fog: null,
  ambient: { colour: rgbFromHex(0x101018), intensity: 0.25 },
  key: null,
};

export const DAWN: EnvironmentSpec = {
  sky: {
    kind: "gradient",
    top: rgbFromHex(0x1b3b6f),
    bottom: rgbFromHex(0xf3a26d),
    horizon: 0.45,
    exponent: 1.3,
  },
  fog: { kind: "linear", colour: rgbFromHex(0xd9a184), near: 12, far: 90 },
  ambient: { colour: rgbFromHex(0x6f7fa8), intensity: 0.6 },
  key: { colour: rgbFromHex(0xffcf9e), intensity: 1.1, direction: [-0.7, -0.25, -0.65] },
};

export const NOON: EnvironmentSpec = {
  sky: {
    kind: "gradient",
    top: rgbFromHex(0x2d6fd0),
    bottom: rgbFromHex(0xbcd9f5),
    horizon: 0.5,
  },
  fog: { kind: "linear", colour: rgbFromHex(0xbcd9f5), near: 30, far: 250 },
  ambient: { colour: rgbFromHex(0xc7dcf5), intensity: 1 },
  key: { colour: rgbFromHex(0xfff6e2), intensity: 2.2, direction: [-0.3, -0.9, -0.3] },
};

export const DUSK: EnvironmentSpec = {
  sky: {
    kind: "gradient",
    top: rgbFromHex(0x140f2e),
    bottom: rgbFromHex(0xd2543a),
    horizon: 0.4,
    exponent: 1.6,
  },
  fog: { kind: "linear", colour: rgbFromHex(0x6b3550), near: 8, far: 70 },
  ambient: { colour: rgbFromHex(0x54507a), intensity: 0.5 },
  key: { colour: rgbFromHex(0xff9a5c), intensity: 0.9, direction: [0.75, -0.2, 0.6] },
};

export const NIGHT: EnvironmentSpec = {
  sky: {
    kind: "gradient",
    top: rgbFromHex(0x05060f),
    bottom: rgbFromHex(0x121a33),
    horizon: 0.5,
  },
  fog: { kind: "linear", colour: rgbFromHex(0x0a0d1a), near: 5, far: 45 },
  ambient: { colour: rgbFromHex(0x2a3350), intensity: 0.35 },
  key: { colour: rgbFromHex(0x9fb6ff), intensity: 0.4, direction: [0.2, -0.85, -0.5] },
};

export const OVERCAST: EnvironmentSpec = {
  sky: { kind: "solid", colour: rgbFromHex(0x9aa4ad) },
  fog: { kind: "exponential", colour: rgbFromHex(0x9aa4ad), density: 0.012 },
  ambient: { colour: rgbFromHex(0xb6bec6), intensity: 1.4 },
  key: { colour: rgbFromHex(0xdde3e8), intensity: 0.6, direction: [-0.2, -0.95, -0.2] },
};

/** All of the above, ready to hand to `EnvironmentDirector`'s `presets`. */
export const STOCK_PRESETS: Readonly<Record<string, EnvironmentSpec>> = {
  void: VOID,
  dawn: DAWN,
  noon: NOON,
  dusk: DUSK,
  night: NIGHT,
  overcast: OVERCAST,
};

/**
 * The same fog, pushed far enough away to be invisible.
 *
 * This is the workaround for the one rule in `interpolate.ts`: a slot cannot
 * ease between "something" and `null`, so easing fog IN means transitioning
 * from a fog that is technically present but has no effect. Use this rather
 * than hand-writing a `far: 100000` twin of every fog preset:
 *
 * ```ts
 * director.apply({ fog: clearedFog(DUSK.fog!) });   // no visible fog
 * director.transition({ fog: DUSK.fog! }, { durationMs: 4000 });  // rolls in
 * ```
 */
export function clearedFog(fog: FogSpec, distance = 100_000): FogSpec {
  return fog.kind === "linear"
    ? { kind: "linear", colour: fog.colour, near: distance, far: distance * 2 }
    : { kind: "exponential", colour: fog.colour, density: 0 };
}
