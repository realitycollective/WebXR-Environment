/**
 * `WorldSensingPort` for Google XR Blocks.
 *
 * ---------------------------------------------------------------------------
 * XR BLOCKS HANDS BACK MESHES, NOT MEASUREMENTS
 * ---------------------------------------------------------------------------
 * Its `PlaneDetector` and `MeshDetector` turn WebXR's planes and meshes into
 * three.js objects and keep them positioned. That is more than the raw WebXR
 * path gives and less than IWSDK's: there is a `label` and a transform, but
 * the size has to come from the geometry, so this port reads the bounding box
 * rather than walking vertices itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT HAVE
 * ---------------------------------------------------------------------------
 * Anchors and a readable hit test. XR Blocks has PLACEMENT helpers -
 * `placeOnSurface`, `anchorObjectAtReticle` - which move an object for you and
 * hand nothing back, so they cannot answer "where would this ray land". Both
 * features report `unsupported` with that sentence, rather than this adapter
 * inventing an answer or an app discovering the gap on a device.
 */
import { Quaternion, Vector3 } from "three";
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  SensingFeature,
  SensingReport,
  WorldMesh,
  WorldPlane,
  WorldPlaneOrientation,
  WorldSensingPort,
  WorldSensingPortHost,
  WorldPose,
} from "@realitycollective/webxr-environment";
import type { XBDetectedMeshLike, XBDetectedPlaneLike, XBWorldLike } from "./xrblocks.js";

const TEMP_POSITION = new Vector3();
const TEMP_QUATERNION = new Quaternion();

export class XRBlocksWorldSensingPort implements WorldSensingPort {
  readonly #world: XBWorldLike;
  readonly #ids = new WeakMap<object, string>();
  readonly #states = new Map<SensingFeature, string>();

  #host: WorldSensingPortHost | null = null;
  #detection: ResolvedWorldDetection | null = null;
  #nextId = 1;

  constructor(world: XBWorldLike) {
    this.#world = world;
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
      for (const feature of ["planes", "meshes"] as const) {
        this.#report({ feature, state: "unavailable", detail: "detection is off" });
      }
      return;
    }
    this.#announce("planes", detection.planes, this.#world.planes !== undefined, "world.planes");
    this.#announce("meshes", detection.meshes, this.#world.meshes !== undefined, "world.meshes");
    if (detection.anchors) {
      this.#report({
        feature: "anchors",
        state: "unsupported",
        detail: "XR Blocks places objects for you and exposes no anchors to read",
      });
    }
  }

  startHitTest(_request: HitTestRequest): void {
    this.#report({
      feature: "hitTest",
      state: "unsupported",
      detail: "XR Blocks has placeOnSurface, which moves an object rather than reporting a hit",
    });
  }

  async createAnchor(): Promise<string | null> {
    this.#report({
      feature: "anchors",
      state: "unsupported",
      detail: "XR Blocks places objects for you and exposes no anchors to read",
    });
    return null;
  }

  update(): void {
    const detection = this.#detection;
    if (detection === null || this.#host === null) return;
    if (detection.planes) this.#readPlanes();
    if (detection.meshes) this.#readMeshes();
  }

  dispose(): void {
    this.#host = null;
  }

  #readPlanes(): void {
    const detector = this.#world.planes;
    if (detector === undefined) return;
    const planes: WorldPlane[] = [];
    for (const detected of detector.get()) {
      const polygon = (detected.xrPlane?.polygon === undefined
        ? []
        : Array.from(detected.xrPlane.polygon)
      ).map((point) => [point.x, point.z] as const);
      planes.push({
        id: this.#idFor(detected),
        pose: poseOf(detected),
        // The polygon is the better measurement when there is one; the
        // geometry XR Blocks built from it is the fallback.
        extents: polygon.length > 0 ? extentsOf(polygon) : planarBoundsOf(detected),
        orientation: orientationOf(detected.orientation),
        label: detected.label?.toLowerCase() ?? null,
        ...(polygon.length === 0 ? {} : { polygon }),
        ...(detected.xrPlane?.lastChangedTime === undefined
          ? {}
          : { changedAt: detected.xrPlane.lastChangedTime }),
      });
    }
    this.#host?.planes(planes);
    this.#report({ feature: "planes", state: "active", detail: planes.length + " surfaces" });
  }

  #readMeshes(): void {
    const detector = this.#world.meshes;
    if (detector === undefined) return;
    const meshes: WorldMesh[] = [];
    for (const detected of detector.xrMeshToThreeMesh?.values() ?? []) {
      meshes.push({
        id: this.#idFor(detected),
        pose: poseOf(detected),
        extents: boundsOf(detected),
        label: detected.semanticLabel?.toLowerCase() ?? null,
      });
    }
    this.#host?.meshes(meshes);
    this.#report({ feature: "meshes", state: "active", detail: meshes.length + " meshes" });
  }

  #announce(
    feature: "planes" | "meshes",
    wanted: boolean,
    present: boolean,
    option: string,
  ): void {
    if (!wanted) {
      this.#report({ feature, state: "unavailable", detail: "detection is off" });
      return;
    }
    this.#report(
      present
        ? { feature, state: "pending", detail: "waiting for XR Blocks to find something" }
        : {
            feature,
            state: "unavailable",
            detail: "XR Blocks was built without " + option + "; enable it in its options",
          },
    );
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
    const stamp = report.state + "|" + report.detail;
    if (this.#states.get(report.feature) === stamp) return;
    this.#states.set(report.feature, stamp);
    this.#host?.report(report);
  }
}

function poseOf(object: XBDetectedPlaneLike | XBDetectedMeshLike): WorldPose {
  object.getWorldPosition(TEMP_POSITION);
  object.getWorldQuaternion(TEMP_QUATERNION);
  return {
    position: [TEMP_POSITION.x, TEMP_POSITION.y, TEMP_POSITION.z],
    orientation: [TEMP_QUATERNION.x, TEMP_QUATERNION.y, TEMP_QUATERNION.z, TEMP_QUATERNION.w],
  };
}

/** The bounding box of what XR Blocks built, computing it once if need be. */
function boxOf(
  object: XBDetectedPlaneLike | XBDetectedMeshLike,
): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
  const geometry = object.geometry;
  if (geometry === undefined) return null;
  if (geometry.boundingBox === null || geometry.boundingBox === undefined) {
    geometry.computeBoundingBox?.();
  }
  return geometry.boundingBox ?? null;
}

function boundsOf(object: XBDetectedMeshLike): WorldMesh["extents"] {
  const box = boxOf(object);
  if (box === null) return null;
  return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z];
}

/** A plane's width and depth from the geometry XR Blocks laid flat in XZ. */
function planarBoundsOf(object: XBDetectedPlaneLike): readonly [number, number] {
  const box = boxOf(object);
  if (box === null) return [0, 0];
  return [box.max.x - box.min.x, box.max.z - box.min.z];
}

function orientationOf(value: string | undefined): WorldPlaneOrientation {
  const lowered = value?.toLowerCase();
  if (lowered === "horizontal" || lowered === "vertical") return lowered;
  return "unknown";
}

function extentsOf(polygon: readonly (readonly [number, number])[]): readonly [number, number] {
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
