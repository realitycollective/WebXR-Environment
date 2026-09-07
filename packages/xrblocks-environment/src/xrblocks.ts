/**
 * The shape of the two Google XR Blocks managers this adapter drives.
 *
 * Structural, not imported, following the convention the other XR Blocks
 * adapters in this estate use: the package has no `xrblocks` dependency, an
 * app hands in whatever it already has, and every one of these shapes can be
 * an object literal in a test.
 *
 * Verified against `xrblocks` 0.21.1 (`src/depth/Depth.ts`,
 * `src/depth/DepthOptions.ts`, `src/lighting/Lighting.ts`), 2026-09.
 */

/** A `THREE.Color`, seen through the two things this adapter reads. */
export interface ColourLike {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * `DepthOptions`, of which this adapter writes only the blur flags.
 *
 * The session preferences (`usagePreference`, `dataFormatPreference`,
 * `depthTypeRequest`, `matchDepthView`) are here because XR Blocks is the one
 * host that exposes them - but XR Blocks reads them when it requests the
 * session, so writing them afterwards would be a lie. This adapter reports
 * what it could not honour instead.
 */
export interface XBDepthOptionsLike {
  enabled?: boolean;
  occlusion?: { enabled?: boolean };
  depthTexture?: {
    enabled?: boolean;
    constantKernel?: boolean;
    applyGaussianBlur?: boolean;
    applyKawaseBlur?: boolean;
  };
  usagePreference?: readonly string[];
  dataFormatPreference?: readonly string[];
  depthTypeRequest?: readonly string[];
  matchDepthView?: boolean;
}

/** `xb.core.depth`. */
export interface XBDepthLike {
  readonly options?: XBDepthOptionsLike;
  /** Add a client, which is how XR Blocks decides depth is wanted this frame. */
  resumeDepth?(client: object): void;
  /** Remove one. Depth stops when the last client goes. */
  pauseDepth?(client: object): void;
  /** A depth texture for one view, once there is one. */
  getTexture?(viewId: number): unknown;
}

/** `LightingOptions`. */
export interface XBLightingOptionsLike {
  enabled?: boolean;
  useAmbientSH?: boolean;
  useDirectionalLight?: boolean;
  castDirectionalLightShadow?: boolean;
}

/**
 * `xb.core.lighting`.
 *
 * `ambientLight` is the DC band of the estimated probe, which XR Blocks copies
 * out of `lightProbe.sh.coefficients[0]` every frame - the same three numbers
 * WebXR hands back, so the same conversion applies.
 */
export interface XBLightingLike {
  readonly options?: XBLightingOptionsLike;
  readonly dirLight?: {
    readonly color: ColourLike;
    readonly intensity: number;
    readonly position: Vec3Like;
  };
  readonly ambientLight?: Vec3Like;
  readonly ambientProbe?: { readonly intensity: number };
}

/** What an app hands this adapter. Both members are optional and both degrade. */
export interface XRBlocksEnvironmentContext {
  readonly depth?: XBDepthLike;
  readonly lighting?: XBLightingLike;
}

/** The three.js object XR Blocks builds for a detected surface or mesh. */
export interface XBObject3DLike {
  getWorldPosition(target: { x: number; y: number; z: number }): unknown;
  getWorldQuaternion(target: { x: number; y: number; z: number; w: number }): unknown;
  readonly geometry?: {
    boundingBox?: {
      readonly min: { readonly x: number; readonly y: number; readonly z: number };
      readonly max: { readonly x: number; readonly y: number; readonly z: number };
    } | null;
    computeBoundingBox?(): void;
  };
}

/** `DetectedPlane`: a mesh built from the polygon, with the label beside it. */
export interface XBDetectedPlaneLike extends XBObject3DLike {
  readonly label?: string;
  readonly orientation?: string;
  readonly xrPlane?: {
    readonly polygon?: ArrayLike<{ readonly x: number; readonly z: number }>;
    readonly lastChangedTime?: number;
  } | null;
}

/** `DetectedMesh`. */
export interface XBDetectedMeshLike extends XBObject3DLike {
  readonly semanticLabel?: string;
}

export interface XBPlaneDetectorLike {
  /** Every detected plane, or those carrying one label. */
  get(label?: string): readonly XBDetectedPlaneLike[];
}

export interface XBMeshDetectorLike {
  /** XR Blocks keys its meshes by the raw `XRMesh`; only the values are read. */
  readonly xrMeshToThreeMesh?: { values(): Iterable<XBDetectedMeshLike> };
}

/** `xb.core.world`. Both detectors are absent unless enabled at init. */
export interface XBWorldLike {
  readonly planes?: XBPlaneDetectorLike;
  readonly meshes?: XBMeshDetectorLike;
}
