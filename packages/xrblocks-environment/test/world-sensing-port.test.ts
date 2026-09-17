/**
 * The XR Blocks world-sensing port.
 *
 * XR Blocks hands back three.js objects rather than raw WebXR data, so the
 * fixtures here are objects with a transform and a bounding box - which is
 * what a `DetectedPlane` and a `DetectedMesh` are.
 */
import { describe, expect, it } from "vitest";
import { Box3, Mesh, PlaneGeometry, Vector3 } from "three";
import type {
  SensingReport,
  WorldMesh,
  WorldPlane,
  WorldSensingPortHost,
  XBDetectedMeshLike,
  XBDetectedPlaneLike,
  XBWorldLike,
} from "@realitycollective/xrblocks-environment";
import {
  createXRBlocksWorldSensing,
  XRBlocksWorldSensingPort,
} from "@realitycollective/xrblocks-environment";

function recordingHost(): {
  host: WorldSensingPortHost;
  planes: WorldPlane[][];
  meshes: WorldMesh[][];
  reports: SensingReport[];
} {
  const planes: WorldPlane[][] = [];
  const meshes: WorldMesh[][] = [];
  const reports: SensingReport[] = [];
  return {
    planes,
    meshes,
    reports,
    host: {
      planes: (value) => planes.push([...value]),
      meshes: (value) => meshes.push([...value]),
      anchors: () => {},
      hits: () => {},
      report: (report) => reports.push(report),
    },
  };
}

/** A stand-in for `DetectedPlane`: a real three.js mesh with XR Blocks' fields. */
function detectedPlane(overrides: Partial<XBDetectedPlaneLike> = {}): XBDetectedPlaneLike {
  const object = new Mesh(new PlaneGeometry(2, 4));
  object.position.set(1, 0, 2);
  object.updateMatrixWorld();
  return Object.assign(object, { label: "TABLE", orientation: "Horizontal" }, overrides);
}

function detectedMesh(label = "WALL"): XBDetectedMeshLike {
  const object = new Mesh(new PlaneGeometry(3, 1));
  object.updateMatrixWorld();
  return Object.assign(object, { semanticLabel: label });
}

function fakeWorld(planes: XBDetectedPlaneLike[] = [], meshes: XBDetectedMeshLike[] = []) {
  const world: XBWorldLike = {
    planes: { get: () => planes },
    meshes: { xrMeshToThreeMesh: { values: () => meshes } },
  };
  return world;
}

function setup(world: XBWorldLike) {
  const port = new XRBlocksWorldSensingPort(world);
  const recorder = recordingHost();
  port.observe(recorder.host);
  return { port, ...recorder };
}

const ALL = { planes: true, meshes: true, anchors: true };

describe("planes", () => {
  it("prefers the polygon and falls back to the geometry XR Blocks built", () => {
    const withPolygon = detectedPlane({
      xrPlane: {
        polygon: [
          { x: -0.5, z: -1 },
          { x: 0.5, z: -1 },
          { x: 0.5, z: 1 },
          { x: -0.5, z: 1 },
        ],
        lastChangedTime: 3,
      },
    });
    const { port, planes, reports } = setup(fakeWorld([withPolygon]));
    port.setDetection(ALL);
    port.update();

    const [plane] = planes.at(-1) ?? [];
    expect(plane?.pose.position).toEqual([1, 0, 2]);
    expect(plane?.extents).toEqual([1, 2]);
    expect(plane?.label).toBe("table");
    expect(plane?.orientation).toBe("horizontal");
    expect(plane?.changedAt).toBe(3);
    expect(reports.filter((report) => report.feature === "planes").at(-1)?.detail).toBe(
      "1 surfaces",
    );

    // No polygon: the size comes from the mesh XR Blocks laid flat in XZ. A
    // PlaneGeometry is built in XY, so its own box is 2 x 4 x 0 until the
    // rotation XR Blocks applies - which is why the depth reads as zero here.
    const bare = new Mesh(new PlaneGeometry(2, 4));
    bare.updateMatrixWorld();
    const geometric = bare as unknown as XBDetectedPlaneLike;
    const second = setup(fakeWorld([geometric]));
    second.port.setDetection(ALL);
    second.port.update();
    const [fallback] = second.planes.at(-1) ?? [];
    expect(fallback?.extents?.[0]).toBe(2);
    expect(fallback?.label).toBeNull();
    expect(fallback?.orientation).toBe("unknown");
  });

  it("has no size when there is neither a polygon nor a geometry", () => {
    const nothing: XBDetectedPlaneLike = {
      getWorldPosition: (target) => target,
      getWorldQuaternion: (target) => target,
    };
    const { port, planes } = setup(fakeWorld([nothing]));
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)?.[0]?.extents).toEqual([0, 0]);
  });

  it("has no size when the geometry cannot measure itself", () => {
    const unmeasurable: XBDetectedPlaneLike = {
      getWorldPosition: (target) => target,
      getWorldQuaternion: (target) => target,
      // A geometry with no box and no way to compute one: whatever XR Blocks
      // built, it cannot say how big it is, and neither can this.
      geometry: {},
    };
    const { port, planes } = setup(fakeWorld([unmeasurable]));
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)?.[0]?.extents).toEqual([0, 0]);
  });

  it("keeps an id stable across frames", () => {
    const plane = detectedPlane();
    const { port, planes } = setup(fakeWorld([plane]));
    port.setDetection(ALL);
    port.update();
    port.update();
    expect(planes[0]?.[0]?.id).toBe(planes[1]?.[0]?.id);
  });
});

describe("meshes", () => {
  it("reads the label and measures the geometry once it has a box", () => {
    const mesh = detectedMesh();
    const { port, meshes } = setup(fakeWorld([], [mesh]));
    port.setDetection(ALL);
    port.update();

    const [read] = meshes.at(-1) ?? [];
    expect(read?.label).toBe("wall");
    expect(read?.extents?.[0]).toBe(3);
    // The mesh is the app's to draw; nothing here creates geometry.
    expect(read?.vertices).toBeUndefined();
  });

  it("uses a box that has already been computed", () => {
    const mesh = detectedMesh();
    (mesh as unknown as Mesh).geometry.boundingBox = new Box3(
      new Vector3(0, 0, 0),
      new Vector3(5, 5, 5),
    );
    const { port, meshes } = setup(fakeWorld([], [mesh]));
    port.setDetection(ALL);
    port.update();
    expect(meshes.at(-1)?.[0]?.extents).toEqual([5, 5, 5]);
  });

  it("reads nothing from a detector with no map behind it", () => {
    const { port, meshes } = setup({ meshes: {} });
    port.setDetection(ALL);
    port.update();
    expect(meshes.at(-1)).toEqual([]);
  });

  it("has no size for an object with no geometry at all", () => {
    const bare: XBDetectedMeshLike = {
      getWorldPosition: (target) => target,
      getWorldQuaternion: (target) => target,
    };
    const { port, meshes } = setup(fakeWorld([], [bare]));
    port.setDetection(ALL);
    port.update();
    expect(meshes.at(-1)?.[0]?.extents).toBeNull();
  });
});

describe("what XR Blocks does not have", () => {
  it("says anchors and hit testing are somebody else's job here", async () => {
    const { port, reports } = setup(fakeWorld());
    port.setDetection(ALL);
    expect(reports.find((report) => report.feature === "anchors")?.detail).toContain(
      "exposes no anchors",
    );

    port.startHitTest({ id: "pointer", space: "viewer" });
    expect(reports.at(-1)?.detail).toContain("placeOnSurface");

    await expect(port.createAnchor()).resolves.toBeNull();
  });

  it("says which detector was never enabled", () => {
    const { port, reports } = setup({});
    port.setDetection(ALL);
    const details = reports.map((report) => report.detail ?? "");
    expect(details.some((detail) => detail.includes("world.planes"))).toBe(true);
    expect(details.some((detail) => detail.includes("world.meshes"))).toBe(true);

    // And reads nothing, rather than throwing on the missing detector.
    port.update();
    expect(reports.filter((report) => report.state === "active")).toHaveLength(0);
  });
});

describe("turning it on and off", () => {
  it("empties what it found and stops reading", () => {
    const { port, planes, meshes } = setup(fakeWorld([detectedPlane()], [detectedMesh()]));
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)).toHaveLength(1);

    port.setDetection(null);
    expect(planes.at(-1)).toEqual([]);
    expect(meshes.at(-1)).toEqual([]);
    const before = planes.length;
    port.update();
    expect(planes).toHaveLength(before);
  });

  it("reads only what was asked for", () => {
    const { port, planes, meshes, reports } = setup(
      fakeWorld([detectedPlane()], [detectedMesh()]),
    );
    port.setDetection({ planes: true, meshes: false, anchors: false });
    port.update();
    expect(planes.at(-1)).toHaveLength(1);
    expect(meshes).toHaveLength(0);
    expect(reports.filter((report) => report.feature === "meshes").at(-1)?.detail).toBe(
      "detection is off",
    );
  });

  it("reads meshes without planes just as happily", () => {
    const { port, planes, meshes } = setup(fakeWorld([detectedPlane()], [detectedMesh()]));
    port.setDetection({ planes: false, meshes: true, anchors: false });
    port.update();
    expect(meshes.at(-1)).toHaveLength(1);
    expect(planes).toHaveLength(0);
  });

  it("goes quiet once the director lets go", () => {
    const world = fakeWorld([detectedPlane()]);
    const port = new XRBlocksWorldSensingPort(world);
    const { host, planes } = recordingHost();
    const stop = port.observe(host);
    stop();
    port.setDetection(ALL);
    port.update();
    expect(planes).toHaveLength(0);
    port.dispose();
  });

  it("wires up through one call, like the environment does", () => {
    const { director } = createXRBlocksWorldSensing(fakeWorld([detectedPlane()]), {
      detection: { planes: true },
    });
    director.update(16);
    expect(director.planes()).toHaveLength(1);
    expect(director.getSensing("planes").state).toBe("active");
    director.dispose();
  });
});
