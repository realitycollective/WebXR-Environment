/**
 * The environment contract: what the world around the player looks like,
 * described as plain data with no engine types in it.
 *
 * ---------------------------------------------------------------------------
 * WHY PLAIN DATA
 * ---------------------------------------------------------------------------
 * An `EnvironmentSpec` is serialisable, diffable and comparable. That is what
 * lets the director interpolate between two of them, push only the slots that
 * actually changed, and hand the result to an adapter that knows nothing about
 * how the description was produced. It is also why colours are `[r, g, b]`
 * tuples in 0..1 rather than `THREE.Color` or an IWSDK `Types.Color` view.
 *
 * ---------------------------------------------------------------------------
 * PLATFORM FEATURES, NEVER CONTENT
 * ---------------------------------------------------------------------------
 * Every slot below is a PLATFORM feature that each host exposes differently:
 * three.js has `scene.background` and `Fog`; IWSDK has `DomeGradient` and
 * `AmbientLightComponent`; a third host will have something else again. This
 * contract is the one description all of them can be driven from - that is the
 * whole job.
 *
 * CONTENT is the app's and stays the app's: meshes, prefabs, placement, spawn
 * tables, floors. There is no geometry in this file and there must never be
 * one. If a slot could be built by the app out of a mesh and a material, it
 * does not belong here.
 */

/** An sRGB colour, one channel per component, each in 0..1. */
export type Rgb = readonly [number, number, number];

/** A direction or position in world space, metres. Need not be normalised. */
export type Vec3 = readonly [number, number, number];

/**
 * A vertical gradient sky. `top` sits at the zenith and `bottom` at the nadir;
 * `horizon` is where they meet, as a fraction of the way up the sphere.
 */
export interface SkyGradient {
  readonly kind: "gradient";
  readonly top: Rgb;
  readonly bottom: Rgb;
  /** 0 (nadir) .. 1 (zenith). Default 0.5. */
  readonly horizon?: number;
  /** Sharpens (>1) or softens (<1) the blend. Default 1, a linear ramp. */
  readonly exponent?: number;
}

/** A single flat colour behind everything. The cheapest sky there is. */
export interface SkySolid {
  readonly kind: "solid";
  readonly colour: Rgb;
}

export type SkySpec = SkyGradient | SkySolid;

/** Fog that ramps between two distances. */
export interface FogLinear {
  readonly kind: "linear";
  readonly colour: Rgb;
  /** Metres at which fog begins. */
  readonly near: number;
  /** Metres at which fog is total. */
  readonly far: number;
}

/** Fog that thickens exponentially with distance. */
export interface FogExponential {
  readonly kind: "exponential";
  readonly colour: Rgb;
  readonly density: number;
}

export type FogSpec = FogLinear | FogExponential;

/** Uniform illumination from every direction. */
export interface AmbientLightSpec {
  readonly colour: Rgb;
  readonly intensity: number;
}

/** The one directional light most scenes need: a sun, a moon, a work lamp. */
export interface KeyLightSpec {
  readonly colour: Rgb;
  readonly intensity: number;
  /** The direction the light TRAVELS, world space. `[0, -1, 0]` is overhead. */
  readonly direction: Vec3;
  readonly castShadow?: boolean;
}

/**
 * A PARTIAL description of the environment.
 *
 * The two ways of saying "nothing" are distinct and both meaningful:
 *
 * - **omitted** - leave this slot exactly as it is. `{ fog: null }` clears the
 *   fog and touches nothing else.
 * - **`null`** - turn this slot off.
 *
 * That is what makes presets composable: a "storm" preset can carry only the
 * fog and sky it cares about and inherit the lighting it is layered onto.
 */
export interface EnvironmentSpec {
  readonly sky?: SkySpec | null;
  readonly fog?: FogSpec | null;
  readonly ambient?: AmbientLightSpec | null;
  readonly key?: KeyLightSpec | null;
}

/** Every slot decided. This is what the director holds and adapters receive. */
export interface ResolvedEnvironment {
  readonly sky: SkySpec | null;
  readonly fog: FogSpec | null;
  readonly ambient: AmbientLightSpec | null;
  readonly key: KeyLightSpec | null;
}

/** The slot names, in the order the director pushes them to the port. */
export const ENVIRONMENT_SLOTS = ["sky", "fog", "ambient", "key"] as const;

export type EnvironmentSlot = (typeof ENVIRONMENT_SLOTS)[number];

/** An environment with nothing in it: a black void with no light. */
export const EMPTY_ENVIRONMENT: ResolvedEnvironment = Object.freeze({
  sky: null,
  fog: null,
  ambient: null,
  key: null,
});
