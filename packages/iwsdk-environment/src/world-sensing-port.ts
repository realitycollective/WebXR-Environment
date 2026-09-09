/**
 * `WorldSensingPort` for Meta IWSDK.
 *
 * ---------------------------------------------------------------------------
 * IWSDK HAS ALREADY DONE HALF OF THIS
 * ---------------------------------------------------------------------------
 * Where the three.js adapter reads an `XRFrame` directly, IWSDK's own
 * `SceneUnderstandingSystem` has already turned planes, meshes and anchors
 * into ENTITIES with components on them, positioned in the scene. So this port
 * queries for those entities and translates them, rather than reaching past
 * IWSDK to the session - which would fight the system that owns them.
 *
 * The same goes for hit testing: IWSDK's `EnvironmentRaycastSystem` casts from
 * a hand or the viewer and moves a target entity to the hit, so a request here
 * becomes an entity with an `EnvironmentRaycastTarget` on it and the answer is
 * read off that entity's transform.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT CANNOT DO
 * ---------------------------------------------------------------------------
 * Ask for the features. `plane-detection`, `mesh-detection` and `anchors` are
 * session features, IWSDK requests them from its own world configuration, and
 * the session belongs to the platform layer either way. If the app did not ask
 * for them, the queries stay empty forever - so this port says `pending` and
 * keeps saying it, rather than pretending to have turned something on.
 */
import {
  EnvironmentRaycastSystem,
  EnvironmentRaycastTarget,
  RaycastSpace,
  XRAnchor,
  XRMesh,
  XRPlane,
  type Entity,
  type World,
} from "@iwsdk/core";
import { Quaternion, Vector3 } from "three";
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  SensingFeature,
  SensingReport,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldPlaneOrientation,
  WorldPose,
  WorldSensingPort,
  WorldSensingPortHost,
} from "@realitycollective/webxr-environment";

/** The raw `XRPlane` IWSDK keeps on the component, as far as we read it. */
interface RawPlane {
  readonly polygon?: ArrayLike<{ readonly x: number; readonly z: number }>;
  readonly orientation?: string;
  readonly semanticLabel?: string;
  readonly lastChangedTime?: number;
}

/** One elics query, of which this port uses only the entity set. */
interface QueryLike {
  readonly entities: Iterable<Entity>;
}

interface QueryManagerLike {
  registerQuery(config: { required: unknown[] }): QueryLike;
}

export interface IWSDKWorldSensingPortOptions {
  /** Where hit-test target entities are parented. Default: no parent. */
  readonly parent?: Entity;
}

const TEMP_POSITION = new Vector3();
const TEMP_QUATERNION = new Quaternion();

export class IWSDKWorldSensingPort implements WorldSensingPort {
  readonly #world: World;
  readonly #parent: Entity | undefined;
  readonly #ids = new WeakMap<object, string>();
  readonly #hitEntities = new Map<string, Entity>();
  readonly #anchorEntities = new Map<string, Entity>();
  readonly #states = new Map<SensingFeature, string>();

  /**
   * The three queries, registered once at construction.
   *
   * elics keeps one query per component mask and updates it as entities gain
   * and lose components, so registering up front costs one mask walk each and
   * removes any question of whether a set exists yet. An app that never turns
   * detection on simply never reads them.
   */
  readonly #planeQuery: QueryLike;
  readonly #meshQuery: QueryLike;
  readonly #anchorQuery: QueryLike;

  #host: WorldSensingPortHost | null = null;
  #detection: ResolvedWorldDetection | null = null;
  #nextId = 1;

  constructor(world: World, options: IWSDKWorldSensingPortOptions = {}) {
    this.#world = world;
    this.#parent = options.parent;
    const manager = (world as unknown as { queryManager: QueryManagerLike }).queryManager;
    this.#planeQuery = manager.registerQuery({ required: [XRPlane] });
    this.#meshQuery = manager.registerQuery({ required: [XRMesh] });
    this.#anchorQuery = manager.registerQuery({ required: [XRAnchor] });
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
    for (const feature of ["planes", "meshes", "anchors"] as const) {
      this.#report(
        detection[feature]
          ? {
              feature,
              state: "pending",
              detail: "waiting for IWSDK's scene understanding to find something",
            }
          : { feature, state: "unavailable", detail: "detection is off" },
      );
    }
  }

  startHitTest(request: HitTestRequest): void {
    this.#world.registerSystem(EnvironmentRaycastSystem);
    const entity = this.#world.createTransformEntity(
      undefined,
      this.#parent === undefined ? undefined : { parent: this.#parent },
    );
    entity.addComponent(EnvironmentRaycastTarget, { space: raycastSpace(request.space) });
    this.#hitEntities.set(request.id, entity);
    this.#report({
      feature: "hitTest",
      state: "pending",
      detail: "waiting for a hit from the " + request.space + " ray",
    });
  }

  stopHitTest(id: string): void {
    const entity = this.#hitEntities.get(id);
    if (entity === undefined) return;
    this.#hitEntities.delete(id);
    entity.destroy();
  }

  /**
   * IWSDK anchors an ENTITY rather than handing back an anchor object, so this
   * makes one at the requested pose and lets `SceneUnderstandingSystem` attach
   * it. The id that comes back is the same id the anchor will report with.
   */
  async createAnchor(pose: WorldPose): Promise<string | null> {
    const entity = this.#world.createTransformEntity(
      undefined,
      this.#parent === undefined ? undefined : { parent: this.#parent },
    );
    const object3D = entity.object3D;
    if (object3D === undefined) {
      entity.destroy();
      this.#report({
        feature: "anchors",
        state: "unavailable",
        detail: "the anchor entity has no transform to place",
      });
      return null;
    }
    object3D.position.set(pose.position[0], pose.position[1], pose.position[2]);
    object3D.quaternion.set(
      pose.orientation[0],
      pose.orientation[1],
      pose.orientation[2],
      pose.orientation[3],
    );
    object3D.updateMatrixWorld();
    entity.addComponent(XRAnchor);
    const id = this.#idFor(entity as unknown as object);
    this.#anchorEntities.set(id, entity);
    return id;
  }

  removeAnchor(id: string): void {
    const entity = this.#anchorEntities.get(id);
    if (entity === undefined) return;
    this.#anchorEntities.delete(id);
    entity.destroy();
  }

  update(): void {
    const detection = this.#detection;
    if (detection === null || this.#host === null) return;
    if (detection.planes) this.#readPlanes();
    if (detection.meshes) this.#readMeshes();
    if (detection.anchors) this.#readAnchors();
    this.#readHits();
  }

  dispose(): void {
    for (const entity of this.#hitEntities.values()) entity.destroy();
    this.#hitEntities.clear();
    this.#anchorEntities.clear();
    this.#host = null;
  }

  #readPlanes(): void {
    const planes: WorldPlane[] = [];
    for (const entity of this.#planeQuery.entities) {
      const pose = poseOf(entity);
      if (pose === null) continue;
      const raw = entity.getValue(XRPlane, "_plane") as RawPlane | undefined;
      const polygon = (raw?.polygon === undefined ? [] : Array.from(raw.polygon)).map(
        (point) => [point.x, point.z] as const,
      );
      planes.push({
        id: this.#idFor(entity as unknown as object),
        pose,
        extents: extentsOf(polygon),
        orientation: orientationOf(raw?.orientation),
        label: raw?.semanticLabel?.toLowerCase() ?? null,
        ...(polygon.length === 0 ? {} : { polygon }),
        ...(raw?.lastChangedTime === undefined ? {} : { changedAt: raw.lastChangedTime }),
      });
    }
    this.#host?.planes(planes);
    this.#report({ feature: "planes", state: "active", detail: planes.length + " surfaces" });
  }

  #readMeshes(): void {
    const meshes: WorldMesh[] = [];
    for (const entity of this.#meshQuery.entities) {
      const pose = poseOf(entity);
      if (pose === null) continue;
      // IWSDK measures the mesh for us and puts the size on the component, so
      // unlike the raw WebXR path there are no vertices to walk here.
      const dimensions = entity.getVectorView(XRMesh, "dimensions");
      const label = entity.getValue(XRMesh, "semanticLabel");
      meshes.push({
        id: this.#idFor(entity as unknown as object),
        pose,
        // A `Types.Vec3` view always has three components; the assertions are
        // there because `noUncheckedIndexedAccess` cannot know that, and a
        // fallback would be a branch no input can reach.
        extents: [dimensions[0] as number, dimensions[1] as number, dimensions[2] as number],
        label: typeof label === "string" && label.length > 0 ? label.toLowerCase() : null,
      });
    }
    this.#host?.meshes(meshes);
    this.#report({ feature: "meshes", state: "active", detail: meshes.length + " meshes" });
  }

  #readAnchors(): void {
    const anchors: WorldAnchor[] = [];
    for (const entity of this.#anchorQuery.entities) {
      const pose = poseOf(entity);
      if (pose === null) continue;
      anchors.push({
        id: this.#idFor(entity as unknown as object),
        pose,
        // IWSDK's own flag: false until the system has attached the entity to
        // a real anchor, which is exactly what "not tracked yet" means here.
        tracked: entity.getValue(XRAnchor, "attached") === true,
      });
    }
    this.#host?.anchors(anchors);
    this.#report({ feature: "anchors", state: "active", detail: anchors.length + " anchors" });
  }

  #readHits(): void {
    for (const [id, entity] of this.#hitEntities) {
      const result = entity.getValue(EnvironmentRaycastTarget, "xrHitTestResult");
      const pose = poseOf(entity);
      const hits: WorldHit[] =
        result === undefined || result === null || pose === null
          ? []
          : [{ sourceId: id, pose, distance: null }];
      this.#host?.hits(id, hits);
      if (hits.length > 0) {
        this.#report({ feature: "hitTest", state: "active", detail: "hitting the room" });
      }
    }
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

/** The world transform of the entity IWSDK positioned for us. */
function poseOf(entity: Entity): WorldPose | null {
  const object3D = entity.object3D;
  if (object3D === undefined) return null;
  object3D.getWorldPosition(TEMP_POSITION);
  object3D.getWorldQuaternion(TEMP_QUATERNION);
  return {
    position: [TEMP_POSITION.x, TEMP_POSITION.y, TEMP_POSITION.z],
    orientation: [TEMP_QUATERNION.x, TEMP_QUATERNION.y, TEMP_QUATERNION.z, TEMP_QUATERNION.w],
  };
}

function orientationOf(value: string | undefined): WorldPlaneOrientation {
  const lowered = value?.toLowerCase();
  if (lowered === "horizontal" || lowered === "vertical") return lowered;
  return "unknown";
}

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

/** Our three ray sources onto IWSDK's four. */
function raycastSpace(space: HitTestRequest["space"]): string {
  if (space === "left") return RaycastSpace.Left;
  if (space === "right") return RaycastSpace.Right;
  return RaycastSpace.Viewer;
}
