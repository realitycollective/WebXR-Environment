/**
 * The slices of WebXR and of `renderer.xr` this adapter reads.
 *
 * ---------------------------------------------------------------------------
 * WHY STRUCTURAL TYPES AND NOT THE REAL ONES
 * ---------------------------------------------------------------------------
 * Two reasons, and the second is the important one.
 *
 * First, `XRSession`, `XRFrame` and `XRLightProbe` come from the DOM WebXR
 * typings, which are not present in every consumer's `lib`, and the parts used
 * here are small. Naming them structurally keeps this package compiling in a
 * project that has never installed a WebXR type at all.
 *
 * Second, a headset is not a test environment. Everything below can be faked
 * by an object literal, which is how the depth and light-estimation paths in
 * this port are exercised on a machine with no XR device and no GPU. A port
 * that can only be tested on a Quest is a port that is tested once.
 *
 * Every member is optional, because every one of them is absent on some real
 * runtime and the adapter's job is to notice that and say so - and every
 * optional member spells out `| undefined` rather than relying on the `?`.
 * That is not noise. Under `exactOptionalPropertyTypes`, `enabledFeatures?:
 * readonly string[]` does NOT accept a real `XRSession`, whose own type is
 * `string[] | undefined`, so the shorter spelling makes a port that no app can
 * pass its actual renderer to.
 */

/** One `XRLightEstimate`. The three products WebXR's light estimation makes. */
export interface XrLightEstimateLike {
  /** 27 floats, 9 coefficients of 3 channels. Only the first 3 are read here. */
  readonly sphericalHarmonicsCoefficients?: ArrayLike<number> | undefined;
  /** Points TOWARD the brightest light. */
  readonly primaryLightDirection?:
    | { readonly x: number; readonly y: number; readonly z: number }
    | undefined;
  /** Linear RGB, unbounded. */
  readonly primaryLightIntensity?:
    | { readonly x: number; readonly y: number; readonly z: number }
    | undefined;
}

/** An `XRLightProbe`. Opaque: it is only ever handed back to `getLightEstimate`. */
export type XrLightProbeLike = object;

/** One `XRPlane`. `polygon` points are in the plane's own space, metres. */
export interface XrPlaneLike {
  readonly planeSpace?: unknown;
  readonly polygon?: ArrayLike<{ readonly x: number; readonly y: number; readonly z: number }>;
  readonly orientation?: string;
  readonly semanticLabel?: string;
  readonly lastChangedTime?: number;
}

/** One `XRMesh`. The buffers are the runtime's and are never copied here. */
export interface XrMeshLike {
  readonly meshSpace?: unknown;
  readonly vertices?: Float32Array;
  readonly indices?: Uint32Array | Uint16Array;
  readonly semanticLabel?: string;
  readonly lastChangedTime?: number;
}

/** One `XRAnchor`. */
export interface XrAnchorLike {
  readonly anchorSpace?: unknown;
  delete?(): void;
}

/** What `frame.getPose` hands back: a transform, or null when tracking is lost. */
export interface XrPoseLike {
  readonly transform: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly orientation: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
      readonly w: number;
    };
  };
}

export interface XrHitTestResultLike {
  getPose(space: unknown): XrPoseLike | null | undefined;
}

export interface XrFrameLike {
  /** `XRPlaneSet` / `XRMeshSet` / `XRAnchorSet` - all of them iterable sets. */
  readonly detectedPlanes?: Iterable<XrPlaneLike>;
  readonly detectedMeshes?: Iterable<XrMeshLike>;
  readonly trackedAnchors?: Iterable<XrAnchorLike>;
  getPose?(space: unknown, baseSpace: unknown): XrPoseLike | null | undefined;
  getHitTestResults?(source: unknown): readonly XrHitTestResultLike[];
  createAnchor?(pose: unknown, space: unknown): Promise<XrAnchorLike> | undefined;
  getLightEstimate?(probe: XrLightProbeLike): XrLightEstimateLike | null | undefined;
  /**
   * Never read. It is here so that a REAL `XRFrame` is recognised as one.
   *
   * An interface whose members are all optional is a "weak type", and TypeScript
   * rejects an assignment that shares none of them. `getLightEstimate` is
   * missing from the DOM's `XRFrame` in some lib versions, so without a member
   * both shapes have, an app passing its actual renderer gets "has no
   * properties in common" - which is exactly the error this file exists to
   * prevent.
   */
  readonly session?: unknown;
}

/** One `XRInputSource`, as far as a hit test needs it. */
export interface XrInputSourceLike {
  readonly handedness?: string | undefined;
  /** The space the pointing ray starts from. Absent on a source with no ray. */
  readonly targetRaySpace?: unknown;
}

export interface XrSessionLike {
  readonly enabledFeatures?: readonly string[] | undefined;
  /** Live: sources come and go as hands are seen and controllers sleep. */
  readonly inputSources?: Iterable<XrInputSourceLike> | undefined;
  /** `"cpu-optimized"` or `"gpu-optimized"`, once depth sensing is granted. */
  readonly depthUsage?: string | undefined;
  readonly preferredReflectionFormat?: string | undefined;
  requestLightProbe?(options?: { reflectionFormat?: string }): Promise<XrLightProbeLike>;
  requestHitTestSource?(options: {
    space: unknown;
    offsetRay?: unknown;
  }): Promise<{ cancel?(): void }> | undefined;
  requestReferenceSpace?(type: string): Promise<unknown>;
}

/** The part of `renderer.xr` this port uses. */
export interface XrManagerLike {
  getSession(): XrSessionLike | null | undefined;
  /** The space every pose in this adapter is expressed in. */
  getReferenceSpace?(): unknown;
  getFrame?(): XrFrameLike | null | undefined;
  /** three.js's own depth-sensing state. True once a depth texture has arrived. */
  hasDepthSensing?(): boolean;
}

/** A `WebGLRenderer`, seen through the keyhole this port looks through. */
export interface XrRendererLike {
  readonly xr: XrManagerLike;
}
