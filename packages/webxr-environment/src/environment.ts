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
 *
 * `equator` is the colour AT the horizon, and it is optional because two of
 * the three hosts do not need it: three.js builds a ramp from any two colours,
 * and a two-stop gradient is what most skies are. IWSDK's `DomeGradient` is a
 * three-stop sky/equator/ground triple, though, so when this is omitted the
 * IWSDK adapter has to invent the middle colour by sampling the ramp - which
 * is a guess that looks fine until an app deliberately puts a bright band at
 * the horizon and only one of the two engines shows it. Passing it explicitly
 * is how an app makes both engines agree.
 */
export interface SkyGradient {
  readonly kind: "gradient";
  readonly top: Rgb;
  readonly bottom: Rgb;
  /** The colour at the horizon. Derived from the ramp when omitted. */
  readonly equator?: Rgb;
  /** 0 (nadir) .. 1 (zenith). Default 0.5. */
  readonly horizon?: number;
  /** Sharpens (>1) or softens (<1) the blend. Default 1, a linear ramp. */
  readonly exponent?: number;
  /** Brightness multiplier. Default 1. */
  readonly intensity?: number;
}

/** A single flat colour behind everything. The cheapest sky there is. */
export interface SkySolid {
  readonly kind: "solid";
  readonly colour: Rgb;
}

/**
 * An authored sky: an equirectangular image wrapped around the world.
 *
 * `src` is a STRING the adapter resolves, and that is the whole of this
 * package's involvement with asset loading. three.js has its loaders, IWSDK
 * has `AssetManager` and a `DomeTexture` component that takes a path; neither
 * needs this package to fetch anything, and a portable asset layer is a
 * different problem than a portable environment.
 */
export interface SkyTexture {
  readonly kind: "texture";
  readonly src: string;
  /** Brightness multiplier. Default 1. */
  readonly intensity?: number;
  /** Spin about the vertical axis, radians. Default 0. */
  readonly rotationY?: number;
  /** 0..1 softening, for a sky used as a backdrop rather than a subject. */
  readonly blur?: number;
}

export type SkySpec = SkyGradient | SkySolid | SkyTexture;

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
 * Image-based lighting: what the world reflects and how it lights everything
 * that is not lit by the key light.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SLOT AND NOT AN AFTERTHOUGHT
 * ---------------------------------------------------------------------------
 * Without it a physically-based material has nothing to reflect. An app can
 * set a beautiful sky through this package and still get a matte grey sphere,
 * because on every one of the three hosts the sky and the environment map are
 * two separate facilities: `scene.background` and `scene.environment` on
 * three.js, `DomeGradient` and `IBLGradient` on IWSDK. Owning one and not the
 * other is owning half of the lighting.
 *
 * The three kinds are the ones the hosts already ship. `room` is IWSDK's
 * built-in room probe, which three.js also has as `RoomEnvironment`.
 */
export interface IblGradient {
  readonly kind: "gradient";
  readonly top: Rgb;
  readonly bottom: Rgb;
  /** The colour at the horizon. Derived from the ramp when omitted. */
  readonly equator?: Rgb;
  readonly intensity?: number;
  readonly rotationY?: number;
}

export interface IblTexture {
  readonly kind: "texture";
  /** A path the adapter resolves. HDR, EXR or a plain equirect image. */
  readonly src: string;
  readonly intensity?: number;
  readonly rotationY?: number;
}

/** The host's built-in neutral room probe. Neither authored nor measured. */
export interface IblRoom {
  readonly kind: "room";
  readonly intensity?: number;
  readonly rotationY?: number;
}

/**
 * The reflections the HOST measured from the real room.
 *
 * This is a marker, not data, and that is the point. WebXR's light estimation
 * produces a reflection cube map, which is a live texture on a GPU - it cannot
 * be a `src` string or a pair of colours without stopping being what it is. So
 * the app says "use what you measured", the adapter that measured it applies
 * it, and the environment document stays plain data with one honest hole in
 * it rather than pretending a texture is a value.
 *
 * Only an adapter that can actually measure one produces this; the others
 * report `ibl` as unsupported and leave the slot alone. It normally arrives on
 * its own, through `setLightEstimation({ ibl: true })`, but an app may also
 * ask for it directly.
 */
export interface IblEstimated {
  readonly kind: "estimated";
  readonly intensity?: number;
  readonly rotationY?: number;
}

export type IblSpec = IblGradient | IblTexture | IblRoom | IblEstimated;

/**
 * How the host composites what is rendered over the real world.
 *
 * The values are WebXR's own. It matters here because the two passthrough
 * modes behave oppositely: `alpha-blend` composites normally, so black is
 * black, while `additive` ADDS the rendered image to the world, so black is
 * fully transparent and a dark fog or a dark fallback sky simply is not there.
 * An environment that wants to dim the world has to do the opposite thing on
 * each, which it cannot do while it only knows a boolean.
 *
 * This is a structural copy of the string set WebXR defines, not an import: no
 * package here references a sibling, and the platform layer that derives this
 * from the session lives in another repository.
 */
export type EnvironmentBlendMode = "opaque" | "alpha-blend" | "additive";

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
  readonly ibl?: IblSpec | null;
}

/** Every slot decided. This is what the director holds and adapters receive. */
export interface ResolvedEnvironment {
  readonly sky: SkySpec | null;
  readonly fog: FogSpec | null;
  readonly ambient: AmbientLightSpec | null;
  readonly key: KeyLightSpec | null;
  readonly ibl: IblSpec | null;
}

/** The slot names, in the order the director pushes them to the port. */
export const ENVIRONMENT_SLOTS = ["sky", "fog", "ambient", "key", "ibl"] as const;

export type EnvironmentSlot = (typeof ENVIRONMENT_SLOTS)[number];

/** An environment with nothing in it: a black void with no light. */
export const EMPTY_ENVIRONMENT: ResolvedEnvironment = Object.freeze({
  sky: null,
  fog: null,
  ambient: null,
  key: null,
  ibl: null,
});
