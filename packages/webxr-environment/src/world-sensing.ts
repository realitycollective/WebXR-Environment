/**
 * What the headset can tell an app about the actual room: flat surfaces,
 * scanned geometry, anchors that stay put, and where a ray meets the world.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE COMPONENT AND NOT MORE SLOTS
 * ---------------------------------------------------------------------------
 * Every capability in `environment.ts` is something the app DESCRIBES and the
 * host draws. Everything here is the reverse: the host measures, and the app
 * reads. They also have different consumers - a sky is consumed by the eye,
 * while a detected table is consumed by placement, locomotion, physics and
 * interaction, none of which this package owns.
 *
 * So this is a second director with its own port, sharing only the reporting
 * seam in `sensing.ts`, and nothing here is reachable through `EnvironmentSpec`.
 * An app that wants neither pays for neither.
 *
 * ---------------------------------------------------------------------------
 * IT REPORTS GEOMETRY, IT DOES NOT MAKE ANY
 * ---------------------------------------------------------------------------
 * `BOUNDARY.md` says no package here creates geometry, and that stands: a
 * detected plane arrives as a pose, a size and a label, and a mesh's vertices
 * are the HOST's buffers passed through by reference. Nothing here builds a
 * `Mesh`, a collider, a material or a debug visualisation. What an app does
 * with a table it has been told about - draw it, snap to it, walk on it - is
 * the app's, exactly as a floor always was.
 */
import type { Vec3 } from "./environment.js";

/** A rotation as `[x, y, z, w]`. Normalised; the adapters guarantee that. */
export type Quat = readonly [number, number, number, number];

/** Where something is, in whatever reference space the app is using. */
export interface WorldPose {
  readonly position: Vec3;
  readonly orientation: Quat;
}

/**
 * The world features an app can ask for. They are named separately from the
 * environment's because a host can have any subset: Quest has planes, meshes
 * and anchors; a phone AR runtime may have only planes and hit test.
 */
export const WORLD_FEATURES = ["planes", "meshes", "anchors", "hitTest"] as const;

export type WorldFeature = (typeof WORLD_FEATURES)[number];

/** Which of them to turn on. Everything defaults OFF: each one costs. */
export interface WorldDetectionSpec {
  readonly planes?: boolean;
  readonly meshes?: boolean;
  readonly anchors?: boolean;
}

export interface ResolvedWorldDetection {
  readonly planes: boolean;
  readonly meshes: boolean;
  readonly anchors: boolean;
}

export function resolveWorldDetection(spec: WorldDetectionSpec): ResolvedWorldDetection {
  return {
    planes: spec.planes ?? false,
    meshes: spec.meshes ?? false,
    anchors: spec.anchors ?? false,
  };
}

/** Everything on: what `setDetection(true)` means. */
export const ALL_WORLD_DETECTION: ResolvedWorldDetection = Object.freeze({
  planes: true,
  meshes: true,
  anchors: true,
});

/**
 * Roughly which way a surface faces.
 *
 * WebXR says `"horizontal"` or `"vertical"` and nothing else, so a host that
 * knows more (a sloped desk) reports `"unknown"` rather than this contract
 * inventing a third answer nobody can act on.
 */
export type WorldPlaneOrientation = "horizontal" | "vertical" | "unknown";

/**
 * A flat surface the host found: a floor, a wall, a table top.
 *
 * `label` is the host's own semantic vocabulary, lower-cased and passed
 * through rather than mapped to a closed set. Every runtime has a different
 * list, it grows between releases, and an app that switches on `"table"` is
 * better served by an unrecognised string it can log than by a `"other"` this
 * package invented.
 */
export interface WorldPlane {
  /** Stable for as long as the host keeps reporting the same surface. */
  readonly id: string;
  readonly pose: WorldPose;
  /** Size along the plane's own X and Z, metres. */
  readonly extents: readonly [number, number];
  readonly orientation: WorldPlaneOrientation;
  readonly label: string | null;
  /** The boundary in plane space, metres, when the host provides one. */
  readonly polygon?: readonly (readonly [number, number])[];
  /** The host's own change counter, when it has one. See `worldEntryChanged`. */
  readonly changedAt?: number;
}

/**
 * Scanned geometry: furniture, walls, whatever the room-scan produced.
 *
 * `vertices` and `indices` are the HOST's buffers, handed over by reference.
 * They are not copied, because a room mesh is hundreds of kilobytes and
 * copying it every frame to satisfy a tidiness rule would be the wrong trade.
 * Treat them as read-only: an adapter may hand back the same buffer next frame
 * with new contents.
 */
export interface WorldMesh {
  readonly id: string;
  readonly pose: WorldPose;
  /** Axis-aligned size in the mesh's own space, metres, when known. */
  readonly extents: readonly [number, number, number] | null;
  readonly label: string | null;
  readonly vertices?: Float32Array;
  readonly indices?: Uint32Array | Uint16Array;
  readonly changedAt?: number;
}

/**
 * A point in the real world the runtime promises to keep track of.
 *
 * `tracked` goes false when the runtime loses it - after a headset takeoff,
 * or when the player walks into another room. Content parented to a lost
 * anchor should stop pretending it is in the right place.
 */
export interface WorldAnchor {
  readonly id: string;
  readonly pose: WorldPose;
  readonly tracked: boolean;
}

/** Where a ray met the world. */
export interface WorldHit {
  /** The `id` of the `HitTestRequest` this answers. */
  readonly sourceId: string;
  readonly pose: WorldPose;
  /**
   * Metres from where the ray started, or `null` when the host will not say.
   *
   * This is the one field here whose availability differs, and it is worth
   * knowing why: it needs the ray's ORIGIN as well as its hit, and not every
   * host exposes one. Raw WebXR does - the hit-test source is bound to a
   * space, and that space can be posed - so the three.js adapter fills it.
   * IWSDK moves a target entity to the hit and keeps the ray to itself, so it
   * reports `null` there rather than guessing from the head, which would be a
   * different number wearing the same name.
   *
   * An app that needs it everywhere can compute its own from a pose it already
   * has; an app that just wants "ignore anything past three metres" should
   * check for `null` and treat it as "unknown", not as zero.
   */
  readonly distance: number | null;
}

/**
 * A standing question: "where does this ray meet the room".
 *
 * It is standing rather than one-shot because that is what every host offers -
 * a source you create once and read every frame - and because a per-call
 * version would hide how expensive the first one is.
 */
export interface HitTestRequest {
  /** The app's own name for it. Answers come back tagged with this. */
  readonly id: string;
  /**
   * Whose ray. `"viewer"` is the head; `"left"` and `"right"` are the hands or
   * controllers. A host that cannot serve one of them says so.
   */
  readonly space: "viewer" | "left" | "right";
  /** Aim it somewhere other than straight ahead, in the space's own frame. */
  readonly offsetRay?: { readonly origin: Vec3; readonly direction: Vec3 };
}

/**
 * Has this entry changed since the last one with the same id?
 *
 * `changedAt` is the host's own counter (WebXR's `lastChangedTime`), and when
 * both sides have one it is the whole answer - which matters for meshes, where
 * the alternative is comparing two megabytes of vertices every frame to learn
 * that a wall is still a wall. Without it, the fields that describe WHERE the
 * thing is are compared and the buffers are compared by identity.
 */
export function worldEntryChanged(
  previous: WorldPlane | WorldMesh | WorldAnchor,
  next: WorldPlane | WorldMesh | WorldAnchor,
): boolean {
  const previousChangedAt = "changedAt" in previous ? previous.changedAt : undefined;
  const nextChangedAt = "changedAt" in next ? next.changedAt : undefined;
  if (previousChangedAt !== undefined && nextChangedAt !== undefined) {
    return previousChangedAt !== nextChangedAt;
  }
  return JSON.stringify(withoutBuffers(previous)) !== JSON.stringify(withoutBuffers(next));
}

function withoutBuffers(entry: WorldPlane | WorldMesh | WorldAnchor): unknown {
  if (!("vertices" in entry) && !("indices" in entry)) return entry;
  const mesh = entry as WorldMesh;
  return {
    id: mesh.id,
    pose: mesh.pose,
    extents: mesh.extents,
    label: mesh.label,
    // Identity, not contents: an adapter may refill the same buffer in place,
    // and a host that does that also supplies `changedAt`.
    vertices: mesh.vertices === undefined ? null : true,
    indices: mesh.indices === undefined ? null : true,
  };
}

/** What moved since the last flush, per feature. Ids only; read the lists. */
export interface WorldChange {
  readonly feature: "planes" | "meshes" | "anchors";
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}
