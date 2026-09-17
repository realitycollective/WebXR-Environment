/**
 * Real-world depth occlusion: letting the room hide virtual content while
 * passthrough is showing it.
 *
 * ---------------------------------------------------------------------------
 * A MODE, NOT A SLOT
 * ---------------------------------------------------------------------------
 * Sky, fog, ambient and key are eased together because they are one document.
 * Occlusion is not: it is discrete, it is meaningless while the real world is
 * not showing, and there is no honest halfway point between occluded and not.
 * So it sits beside passthrough as a second piece of state the director holds,
 * and the port hears about it only when it actually applies.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS SHAPE CAME FROM
 * ---------------------------------------------------------------------------
 * It is not invented. Every field below is something a host already exposes,
 * and the union is deliberate - a contract built from the thinnest host is a
 * contract that makes the other two worse:
 *
 * - `mode` is IWSDK's `OcclusionShadersMode`: soft, hard and minmax-soft. A
 *   host with one fixed shader reports the mode it could not honour rather
 *   than pretending.
 * - `softness` is IWSDK's `blurRadius` and XR Blocks' choice of blur kernel.
 * - `source` is XR Blocks' `DepthOptions`, which already carries the WebXR
 *   session preferences (`usagePreference`, `dataFormatPreference`,
 *   `depthTypeRequest`, `matchDepthView`) that the other two hosts hide.
 * - `updateFps` is XR Blocks' `depthMeshUpdateFps`, the one knob that turns
 *   depth from a per-frame cost into a budgeted one.
 *
 * What is NOT here is as deliberate. XR Blocks can also build a collidable
 * mesh from depth, patch its holes and receive shadows on it. That is geometry
 * and physics, which this repository does not own, so the sensing knobs are
 * taken and the mesh is left to the app.
 */

/** How hard the edge between real and virtual is drawn. */
export type OcclusionMode = "hard" | "soft" | "minmax-soft";

/** Which content the real world is allowed to hide. */
export type OcclusionScope = "all" | "tagged";

/**
 * How the app would like the depth sensor configured.
 *
 * Every field is a PREFERENCE. A host that cannot pass it on reports
 * `occlusion` as active anyway and says what it ignored, because a refused
 * preference is not a broken feature.
 */
export interface OcclusionSource {
  /**
   * `gpu-optimized` hands back a texture, which is what a depth-priming pass
   * needs and what three.js's built-in path requires. `cpu-optimized` hands
   * back an array, which is what hit-testing against depth needs.
   */
  readonly usage?: "cpu-optimized" | "gpu-optimized";
  readonly format?: "float32" | "luminance-alpha" | "unsigned-short";
  /** `smooth` is temporally filtered; `raw` is what the sensor said. */
  readonly depthType?: "raw" | "smooth";
  /**
   * Ask for depth captured from the same view as the render. When false, a
   * consumer has to sample through `normDepthBufferFromNormView` itself.
   */
  readonly matchDepthView?: boolean;
}

export interface OcclusionSpec {
  readonly mode: OcclusionMode;
  readonly scope: OcclusionScope;
  /** 0..1. Adapters map it to their own units: a blur radius, a kernel choice. */
  readonly softness?: number;
  readonly source?: OcclusionSource;
  /** Cap the sensor update rate. `0` or omitted means every frame. */
  readonly updateFps?: number;
}

/**
 * Soft edges over everything, from a GPU texture.
 *
 * `gpu-optimized` is the default because it is the only usage three.js's
 * built-in occlusion accepts, and because the alternative costs a read back to
 * the CPU that nothing in this package needs.
 */
export const DEFAULT_OCCLUSION: OcclusionSpec = Object.freeze({
  mode: "soft",
  scope: "all",
  source: Object.freeze({ usage: "gpu-optimized" }),
} as const) as OcclusionSpec;
