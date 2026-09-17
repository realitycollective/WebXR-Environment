/**
 * `WorldSensingPort` for plain three.js and raw WebXR.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NOTHING BETWEEN THIS AND THE RUNTIME
 * ---------------------------------------------------------------------------
 * three.js does not model planes, meshes or anchors: it hands back the
 * `XRFrame`, and everything below reads that frame directly. So this port is
 * the reference implementation of the world-sensing contract, and the two
 * other adapters are translations of the same ideas into hosts that already
 * did some of the work.
 *
 * Every pose is expressed in `renderer.xr.getReferenceSpace()`, which is the
 * space three.js draws in, so a position that arrives here can be handed
 * straight to `object.position.set(...)` with no further transform.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS PER FRAME
 * ---------------------------------------------------------------------------
 * Reading a plane means one `getPose` per plane; that is unavoidable, because
 * a plane can move. Reading a MESH would mean walking hundreds of thousands of
 * vertices to find its size, so the extents are computed once per
 * `lastChangedTime` and cached. A room scan that has not changed costs one
 * `getPose` and a map lookup.
 */
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  WorldAnchor,
  WorldMesh,
  WorldPlane,
  WorldPlaneOrientation,
  WorldPose,
  WorldHit,
  WorldSensingPort,
  WorldSensingPortHost,
  SensingFeature,
  SensingReport,
} from "@realitycollective/webxr-environment";
import type {
  XrAnchorLike,
  XrFrameLike,
  XrInputSourceLike,
  XrSessionLike,
  XrMeshLike,
  XrPlaneLike,
  XrPoseLike,
  XrRendererLike,
} from "./xr.js";

export interface ThreeWorldSensingPortOptions {
  /**
   * Builds the `XRRay` an offset ray needs.
   *
   * Injectable for the same reason as `rigidTransform`: `XRRay` is a browser
   * global with no headless stand-in. Without it an offset ray is reported as
   * ignored rather than quietly dropped, because a request that aims somewhere
   * and is answered from somewhere else is worse than one that is refused.
   */
  readonly ray?: (
    origin: { x: number; y: number; z: number; w: number },
    direction: { x: number; y: number; z: number; w: number },
  ) => unknown;
  /**
   * Builds the transform `frame.createAnchor` wants.
   *
   * Defaults to the browser's `XRRigidTransform`. It is injectable because
   * that constructor is a global with no headless stand-in, and an anchor path
   * that could only be exercised on a device is a path that ships untested.
   */
  readonly rigidTransform?: (
    position: { x: number; y: number; z: number },
    orientation: { x: number; y: number; z: number; w: number },
  ) => unknown;
}

interface HitSource {
  readonly request: HitTestRequest;
  source: { cancel?(): void } | null;
  cancelled: boolean;
  /** The space the ray starts from; `null` while waiting for an input source. */
  space: unknown;
  /** The input source that space came from, so we notice it going away. */
  boundTo: XrInputSourceLike | null;
  /** True between asking the runtime for a source and getting one. */
  requesting: boolean;
}

/** The WebXR feature string each detection needs in `enabledFeatures`. */
const FEATURE_NAMES: Record<"planes" | "meshes" | "anchors", string> = {
  planes: "plane-detection",
  meshes: "mesh-detection",
  anchors: "anchors",
};

export class ThreeWorldSensingPort implements WorldSensingPort {
  readonly #renderer: XrRendererLike;
  readonly #rigidTransform: ThreeWorldSensingPortOptions["rigidTransform"];
  readonly #ray: ThreeWorldSensingPortOptions["ray"];
  /** Ids for objects that have none. Weak, so a forgotten plane is collected. */
  readonly #ids = new WeakMap<object, string>();
  readonly #extents = new Map<string, { changedAt: number | undefined; value: WorldMesh["extents"] }>();
  readonly #hitSources = new Map<string, HitSource>();
  readonly #states = new Map<SensingFeature, string>();

  #host: WorldSensingPortHost | null = null;
  #detection: ResolvedWorldDetection | null = null;
  #nextId = 1;

  constructor(renderer: XrRendererLike, options: ThreeWorldSensingPortOptions = {}) {
    this.#renderer = renderer;
    this.#rigidTransform = options.rigidTransform;
    this.#ray = options.ray;
  }

  observe(host: WorldSensingPortHost): () => void {
    this.#host = host;
    return () => {
      this.#host = null;
    };
  }

  setDetection(detection: ResolvedWorldDetection | null): void {
    this.#detection = detection;
    if (detection === null) {
      this.#host?.planes([]);
      this.#host?.meshes([]);
      this.#host?.anchors([]);
      for (const feature of ["planes", "meshes", "anchors"] as const) {
        this.#report({ feature, state: "unavailable", detail: "detection is off" });
      }
      return;
    }
    const session = this.#renderer.xr.getSession();
    const enabled = session?.enabledFeatures ?? [];
    for (const feature of ["planes", "meshes", "anchors"] as const) {
      if (!detection[feature]) {
        this.#report({ feature, state: "unavailable", detail: "detection is off" });
        continue;
      }
      if (session === null || session === undefined) {
        this.#report({ feature, state: "unavailable", detail: "no XR session is running" });
        continue;
      }
      if (!enabled.includes(FEATURE_NAMES[feature])) {
        this.#report({
          feature,
          state: "unavailable",
          detail:
            "the session did not enable " +
            FEATURE_NAMES[feature] +
            "; ask for it when the session is created",
        });
        continue;
      }
      this.#report({ feature, state: "pending", detail: "waiting for the first frame" });
    }
  }

  /**
   * Start a standing hit test.
   *
   * A hand ray is cast from the INPUT SOURCE, not from the head. WebXR binds a
   * hit-test source to a space, and the space for a hand or controller is that
   * source's `targetRaySpace` - so this looks the source up by handedness and
   * binds to it. Input sources come and go (a hand leaves the view, a
   * controller wakes up), so a request that cannot be bound yet stays pending
   * and is retried on every frame, and one whose source disappears is unbound
   * and rebound rather than left aiming at nothing.
   */
  startHitTest(request: HitTestRequest): void {
    const session = this.#renderer.xr.getSession();
    if (session === null || session === undefined) {
      this.#report({ feature: "hitTest", state: "unavailable", detail: "no XR session is running" });
      return;
    }
    if (typeof session.requestHitTestSource !== "function") {
      this.#report({
        feature: "hitTest",
        state: "unsupported",
        detail: "this runtime has no hit test",
      });
      return;
    }
    if (!(session.enabledFeatures ?? []).includes("hit-test")) {
      this.#report({
        feature: "hitTest",
        state: "unavailable",
        detail: "the session did not enable hit-test; ask for it when the session is created",
      });
      return;
    }
    const entry: HitSource = {
      request,
      source: null,
      cancelled: false,
      space: null,
      boundTo: null,
      requesting: false,
    };
    this.#hitSources.set(request.id, entry);
    this.#bind(entry, session);
  }

  stopHitTest(id: string): void {
    const entry = this.#hitSources.get(id);
    if (entry === undefined) return;
    entry.cancelled = true;
    entry.source?.cancel?.();
    this.#hitSources.delete(id);
  }

  async createAnchor(pose: WorldPose): Promise<string | null> {
    const frame = this.#renderer.xr.getFrame?.();
    const space = this.#renderer.xr.getReferenceSpace?.();
    if (frame === null || frame === undefined || typeof frame.createAnchor !== "function") {
      this.#report({
        feature: "anchors",
        state: "unsupported",
        detail: "this runtime cannot create anchors",
      });
      return null;
    }
    const transform = this.#transform(pose);
    if (transform === null) {
      this.#report({
        feature: "anchors",
        state: "unavailable",
        detail: "no XRRigidTransform is available to place the anchor with",
      });
      return null;
    }
    const pending = frame.createAnchor(transform, space);
    if (pending === undefined) return null;
    try {
      const anchor = await pending;
      return this.#idFor(anchor as object);
    } catch {
      // A refused anchor is normal when tracking is poor. The app gets null
      // and decides; it is not an error worth taking a frame down for.
      return null;
    }
  }

  removeAnchor(id: string): void {
    const frame = this.#renderer.xr.getFrame?.();
    for (const anchor of frame?.trackedAnchors ?? []) {
      if (this.#ids.get(anchor as object) !== id) continue;
      anchor.delete?.();
      return;
    }
  }

  update(): void {
    if (this.#host === null) return;
    const detection = this.#detection;
    if (detection === null) {
      // Hit testing is not detection: an app can point at the room without
      // asking for planes, so the sources stay bound either way.
      this.#rebind();
      const bare = this.#renderer.xr.getFrame?.();
      if (bare !== null && bare !== undefined) {
        this.#readHits(bare, this.#renderer.xr.getReferenceSpace?.());
      }
      return;
    }
    const frame = this.#renderer.xr.getFrame?.();
    const reference = this.#renderer.xr.getReferenceSpace?.();
    if (frame === null || frame === undefined) return;

    // Rebinding first: a hand that has just appeared should be answered on the
    // frame it appears, not the one after.
    this.#rebind();
    if (detection.planes) this.#readPlanes(frame, reference);
    if (detection.meshes) this.#readMeshes(frame, reference);
    if (detection.anchors) this.#readAnchors(frame, reference);
    this.#readHits(frame, reference);
  }

  dispose(): void {
    for (const id of [...this.#hitSources.keys()]) this.stopHitTest(id);
    this.#extents.clear();
    this.#host = null;
  }

  #readPlanes(frame: XrFrameLike, reference: unknown): void {
    const detected = frame.detectedPlanes;
    if (detected === undefined) {
      this.#report({
        feature: "planes",
        state: "unavailable",
        detail: "this frame reported no plane set",
      });
      return;
    }
    const planes: WorldPlane[] = [];
    for (const plane of detected) {
      const pose = this.#poseOf(frame, plane.planeSpace, reference);
      if (pose === null) continue;
      const polygon = (plane.polygon === undefined ? [] : Array.from(plane.polygon)).map(
        (point) => [point.x, point.z] as const,
      );
      planes.push({
        id: this.#idFor(plane as object),
        pose,
        extents: extentsOf(polygon),
        orientation: orientationOf(plane.orientation),
        label: plane.semanticLabel?.toLowerCase() ?? null,
        ...(polygon.length === 0 ? {} : { polygon }),
        ...(plane.lastChangedTime === undefined ? {} : { changedAt: plane.lastChangedTime }),
      });
    }
    this.#host?.planes(planes);
    this.#report({
      feature: "planes",
      state: "active",
      detail: planes.length + " surfaces",
    });
  }

  #readMeshes(frame: XrFrameLike, reference: unknown): void {
    const detected = frame.detectedMeshes;
    if (detected === undefined) {
      this.#report({
        feature: "meshes",
        state: "unavailable",
        detail: "this frame reported no mesh set",
      });
      return;
    }
    const meshes: WorldMesh[] = [];
    for (const mesh of detected) {
      const pose = this.#poseOf(frame, mesh.meshSpace, reference);
      if (pose === null) continue;
      const id = this.#idFor(mesh as object);
      meshes.push({
        id,
        pose,
        extents: this.#extentsOf(id, mesh),
        label: mesh.semanticLabel?.toLowerCase() ?? null,
        ...(mesh.vertices === undefined ? {} : { vertices: mesh.vertices }),
        ...(mesh.indices === undefined ? {} : { indices: mesh.indices }),
        ...(mesh.lastChangedTime === undefined ? {} : { changedAt: mesh.lastChangedTime }),
      });
    }
    this.#host?.meshes(meshes);
    this.#report({ feature: "meshes", state: "active", detail: meshes.length + " meshes" });
  }

  #readAnchors(frame: XrFrameLike, reference: unknown): void {
    const tracked = frame.trackedAnchors;
    if (tracked === undefined) {
      this.#report({
        feature: "anchors",
        state: "unavailable",
        detail: "this frame reported no anchor set",
      });
      return;
    }
    const anchors: WorldAnchor[] = [];
    for (const anchor of tracked) {
      const pose = this.#poseOf(frame, anchor.anchorSpace, reference);
      anchors.push({
        id: this.#idFor(anchor as object),
        // A lost anchor keeps its last known pose and says it is not tracked,
        // which is more useful than a hole where the content used to be.
        pose: pose ?? { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
        tracked: pose !== null,
      });
    }
    this.#host?.anchors(anchors);
    this.#report({ feature: "anchors", state: "active", detail: anchors.length + " anchors" });
  }

  #readHits(frame: XrFrameLike, reference: unknown): void {
    if (typeof frame.getHitTestResults !== "function") return;
    for (const [id, entry] of this.#hitSources) {
      if (entry.source === null) continue;
      const results = frame.getHitTestResults(entry.source);
      // Where the ray STARTED, so a hit can carry a distance. One pose per
      // source per frame, not one per hit.
      const origin = this.#poseOf(frame, entry.space, reference);
      const hits: WorldHit[] = [];
      for (const result of results) {
        const pose = result.getPose(reference);
        if (pose === null || pose === undefined) continue;
        const hit = toPose(pose);
        hits.push({
          sourceId: id,
          pose: hit,
          distance: origin === null ? null : metresBetween(origin.position, hit.position),
        });
      }
      this.#host?.hits(id, hits);
    }
  }

  /** Give every unbound request another go, and re-bind one that went stale. */
  #rebind(): void {
    if (this.#hitSources.size === 0) return;
    const session = this.#renderer.xr.getSession();
    if (session === null || session === undefined) return;
    for (const entry of this.#hitSources.values()) {
      if (entry.requesting) continue;
      if (entry.source === null) {
        this.#bind(entry, session);
        continue;
      }
      if (entry.boundTo === null) continue;
      // The hand or controller this ray belonged to is gone: drop the source
      // and go back to waiting, rather than answering from a stale space.
      if (!contains(session.inputSources, entry.boundTo)) {
        entry.source.cancel?.();
        entry.source = null;
        entry.boundTo = null;
        entry.space = null;
        this.#host?.hits(entry.request.id, []);
        this.#report({
          feature: "hitTest",
          state: "pending",
          detail: "the " + entry.request.space + " input source went away",
        });
      }
    }
  }

  /** Resolve the space to cast from, then ask the runtime for a source. */
  #bind(entry: HitSource, session: XrSessionLike): void {
    const request = entry.request;
    let space: unknown;
    if (request.space === "viewer") {
      space = this.#renderer.xr.getReferenceSpace?.();
      entry.boundTo = null;
    } else {
      const source = findInputSource(session.inputSources, request.space);
      if (source === null) {
        this.#report({
          feature: "hitTest",
          state: "pending",
          detail: "waiting for a " + request.space + " hand or controller to point with",
        });
        return;
      }
      space = source.targetRaySpace;
      entry.boundTo = source;
    }
    entry.space = space;

    const offsetRay = this.#offsetRay(request);
    const options = offsetRay === null ? { space } : { space, offsetRay };
    const pending = session.requestHitTestSource?.(options);
    if (pending === undefined) {
      this.#report({ feature: "hitTest", state: "unavailable", detail: "the runtime refused" });
      return;
    }
    entry.requesting = true;
    // Say so the instant we ask, not only when the runtime answers: a request
    // in flight is a state the readout should be able to show.
    this.#report({
      feature: "hitTest",
      state: "pending",
      detail: "asking the runtime for a hit test source",
    });
    const detail =
      "casting from the " +
      request.space +
      (request.offsetRay !== undefined && offsetRay === null
        ? "; the offset ray was ignored because no XRRay is available"
        : "");
    void pending.then(
      (source) => {
        entry.requesting = false;
        if (entry.cancelled) {
          source.cancel?.();
          return;
        }
        entry.source = source;
        this.#report({ feature: "hitTest", state: "active", detail });
      },
      (error: unknown) => {
        entry.requesting = false;
        this.#report({
          feature: "hitTest",
          state: "unavailable",
          detail: "the runtime refused a hit test source: " + String(error),
        });
      },
    );
  }

  /** The `XRRay` for a request that aims somewhere, or null when it cannot. */
  #offsetRay(request: HitTestRequest): unknown {
    const offset = request.offsetRay;
    if (offset === undefined) return null;
    const origin = { x: offset.origin[0], y: offset.origin[1], z: offset.origin[2], w: 1 };
    const direction = {
      x: offset.direction[0],
      y: offset.direction[1],
      z: offset.direction[2],
      w: 0,
    };
    if (this.#ray !== undefined) return this.#ray(origin, direction);
    const Ctor = (globalThis as { XRRay?: new (o: unknown, d: unknown) => unknown }).XRRay;
    return Ctor === undefined ? null : new Ctor(origin, direction);
  }

  #poseOf(frame: XrFrameLike, space: unknown, reference: unknown): WorldPose | null {
    if (space === undefined || typeof frame.getPose !== "function") return null;
    const pose = frame.getPose(space, reference);
    return pose === null || pose === undefined ? null : toPose(pose);
  }

  /**
   * A mesh's size, computed once per change.
   *
   * WebXR gives no bounding box, so the only way to know how big a scanned
   * wall is is to walk its vertices - which is exactly the work that must not
   * happen every frame.
   */
  #extentsOf(id: string, mesh: XrMeshLike): WorldMesh["extents"] {
    const cached = this.#extents.get(id);
    if (cached !== undefined && cached.changedAt === mesh.lastChangedTime) return cached.value;
    const value = boundsOf(mesh.vertices);
    this.#extents.set(id, { changedAt: mesh.lastChangedTime, value });
    return value;
  }

  #transform(pose: WorldPose): unknown {
    const position = { x: pose.position[0], y: pose.position[1], z: pose.position[2] };
    const orientation = {
      x: pose.orientation[0],
      y: pose.orientation[1],
      z: pose.orientation[2],
      w: pose.orientation[3],
    };
    if (this.#rigidTransform !== undefined) return this.#rigidTransform(position, orientation);
    const Ctor = (globalThis as { XRRigidTransform?: new (p: unknown, o: unknown) => unknown })
      .XRRigidTransform;
    return Ctor === undefined ? null : new Ctor(position, orientation);
  }

  #idFor(object: object): string {
    const existing = this.#ids.get(object);
    if (existing !== undefined) return existing;
    const id = "world-" + String(this.#nextId);
    this.#nextId += 1;
    this.#ids.set(object, id);
    return id;
  }

  #report(report: SensingReport): void {
    const previous = this.#states.get(report.feature);
    // Concatenated rather than compared field by field: an absent detail
    // stringifies to "undefined", which is a value like any other here.
    const stamp = report.state + "|" + report.detail;
    if (previous === stamp) return;
    this.#states.set(report.feature, stamp);
    this.#host?.report(report);
  }
}

function toPose(pose: XrPoseLike): WorldPose {
  const { position, orientation } = pose.transform;
  return {
    position: [position.x, position.y, position.z],
    orientation: [orientation.x, orientation.y, orientation.z, orientation.w],
  };
}

/** WebXR says "horizontal" or "vertical"; anything else is not our business. */
function orientationOf(value: string | undefined): WorldPlaneOrientation {
  const lowered = value?.toLowerCase();
  if (lowered === "horizontal" || lowered === "vertical") return lowered;
  return "unknown";
}

/** A polygon's width and depth, from its own bounds. */
function extentsOf(polygon: readonly (readonly [number, number])[]): readonly [number, number] {
  if (polygon.length === 0) return [0, 0];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of polygon) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  return [maxX - minX, maxZ - minZ];
}

/**
 * The axis-aligned size of a vertex buffer, or null when there is none.
 *
 * The three reads are asserted rather than defaulted: the loop bound already
 * guarantees all three exist, and `noUncheckedIndexedAccess` cannot see that.
 * A `?? 0` here would be a branch no input can reach, which is worse than an
 * assertion with a reason next to it.
 */
function boundsOf(vertices: Float32Array | undefined): WorldMesh["extents"] {
  if (vertices === undefined || vertices.length < 3) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index + 2 < vertices.length; index += 3) {
    const x = vertices[index] as number;
    const y = vertices[index + 1] as number;
    const z = vertices[index + 2] as number;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return [maxX - minX, maxY - minY, maxZ - minZ];
}

/** Straight-line metres between two points. */
function metresBetween(from: readonly [number, number, number], to: readonly [number, number, number]): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
}

/** The live input source for one hand, or null while there is not one. */
function findInputSource(
  sources: Iterable<XrInputSourceLike> | undefined,
  handedness: "left" | "right",
): XrInputSourceLike | null {
  for (const source of sources ?? []) {
    if (source.handedness !== handedness) continue;
    // A source with no ray - a gaze-only or tracked-pointer-less source -
    // cannot start a hit test, so it is not a match.
    if (source.targetRaySpace === undefined) continue;
    return source;
  }
  return null;
}

function contains(sources: Iterable<XrInputSourceLike> | undefined, wanted: XrInputSourceLike): boolean {
  for (const source of sources ?? []) {
    if (source === wanted) return true;
  }
  return false;
}
