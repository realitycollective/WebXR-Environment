/**
 * The IWSDK world-sensing port.
 *
 * IWSDK's scene understanding turns the room into entities, so the fixture
 * here is a query set with entities in it - which is exactly what the real
 * system produces. The components are real, so a misspelled field fails here.
 */
import { describe, expect, it } from "vitest";
import {
  EnvironmentRaycastSystem,
  EnvironmentRaycastTarget,
  Object3D,
  RaycastSpace,
  XRAnchor,
  XRMesh,
  XRPlane,
} from "@iwsdk/core";
import type {
  SensingReport,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldSensingPortHost,
} from "@realitycollective/iwsdk-environment";
import { IWSDKWorldSensingPort } from "@realitycollective/iwsdk-environment";
import { asWorld, createFakeEntity, createFakeWorld, type FakeEntity } from "./helpers.js";

function recordingHost(): {
  host: WorldSensingPortHost;
  planes: WorldPlane[][];
  meshes: WorldMesh[][];
  anchors: WorldAnchor[][];
  hits: { id: string; hits: readonly WorldHit[] }[];
  reports: SensingReport[];
} {
  const planes: WorldPlane[][] = [];
  const meshes: WorldMesh[][] = [];
  const anchors: WorldAnchor[][] = [];
  const hits: { id: string; hits: readonly WorldHit[] }[] = [];
  const reports: SensingReport[] = [];
  return {
    planes,
    meshes,
    anchors,
    hits,
    reports,
    host: {
      planes: (value) => planes.push([...value]),
      meshes: (value) => meshes.push([...value]),
      anchors: (value) => anchors.push([...value]),
      hits: (id, value) => hits.push({ id, hits: value }),
      report: (report) => reports.push(report),
    },
  };
}

function setup() {
  const world = createFakeWorld();
  const port = new IWSDKWorldSensingPort(asWorld(world));
  const recorder = recordingHost();
  const stop = port.observe(recorder.host);
  return { world, port, stop, ...recorder };
}

/** An entity placed in the world, as the scene-understanding system leaves it. */
function placed(x = 0, y = 0, z = 0): FakeEntity {
  const object3D = new Object3D();
  object3D.position.set(x, y, z);
  object3D.updateMatrixWorld();
  return createFakeEntity(object3D);
}

const ALL = { planes: true, meshes: true, anchors: true };

describe("planes", () => {
  it("reads IWSDK's plane entities, raw XRPlane and all", () => {
    const { world, port, planes, reports } = setup();
    const entity = placed(1, 0, 2);
    entity.addComponent(XRPlane);
    entity.setValue(XRPlane, "_plane", {
      polygon: [
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: 1, z: 1 },
        { x: -1, z: 1 },
      ],
      orientation: "Horizontal",
      semanticLabel: "TABLE",
      lastChangedTime: 4,
    });

    port.setDetection(ALL);
    world.entitiesWith(XRPlane).add(entity);
    port.update();

    const [plane] = planes.at(-1) ?? [];
    expect(plane?.pose.position).toEqual([1, 0, 2]);
    expect(plane?.extents).toEqual([2, 2]);
    expect(plane?.orientation).toBe("horizontal");
    expect(plane?.label).toBe("table");
    expect(plane?.changedAt).toBe(4);
    expect(reports.filter((report) => report.feature === "planes").at(-1)?.detail).toBe(
      "1 surfaces",
    );
  });

  it("copes with a plane entity IWSDK has not filled in yet", () => {
    const { world, port, planes } = setup();
    const entity = placed();
    entity.addComponent(XRPlane);
    port.setDetection(ALL);
    world.entitiesWith(XRPlane).add(entity);
    port.update();

    const [plane] = planes.at(-1) ?? [];
    expect(plane?.extents).toEqual([0, 0]);
    expect(plane?.orientation).toBe("unknown");
    expect(plane?.label).toBeNull();
    expect(plane?.polygon).toBeUndefined();
  });

  it("skips an entity with no transform", () => {
    const { world, port, planes } = setup();
    const entity = createFakeEntity();
    entity.addComponent(XRPlane);
    port.setDetection(ALL);
    world.entitiesWith(XRPlane).add(entity);
    port.update();
    expect(planes.at(-1)).toEqual([]);
  });
});

describe("meshes and anchors", () => {
  it("takes the size IWSDK already measured", () => {
    const { world, port, meshes } = setup();
    const entity = placed(0, 1, 0);
    entity.addComponent(XRMesh);
    entity.setValue(XRMesh, "semanticLabel", "WALL");
    const dimensions = entity.getVectorView(XRMesh, "dimensions");
    dimensions[0] = 2;
    dimensions[1] = 3;
    dimensions[2] = 0.25;

    port.setDetection(ALL);
    world.entitiesWith(XRMesh).add(entity);
    port.update();

    const [mesh] = meshes.at(-1) ?? [];
    expect(mesh?.extents).toEqual([2, 3, 0.25]);
    expect(mesh?.label).toBe("wall");
    // IWSDK measures for us, so no vertex buffer is passed through here.
    expect(mesh?.vertices).toBeUndefined();
  });

  it("reads an unlabelled mesh as unlabelled", () => {
    const { world, port, meshes } = setup();
    const entity = placed();
    entity.addComponent(XRMesh);
    port.setDetection(ALL);
    world.entitiesWith(XRMesh).add(entity);
    port.update();
    expect(meshes.at(-1)?.[0]?.label).toBeNull();
  });

  it("skips a mesh or an anchor the system has not placed", () => {
    const { world, port, meshes, anchors } = setup();
    const bare = createFakeEntity();
    bare.addComponent(XRMesh);
    const bareAnchor = createFakeEntity();
    bareAnchor.addComponent(XRAnchor);
    port.setDetection(ALL);
    world.entitiesWith(XRMesh).add(bare);
    world.entitiesWith(XRAnchor).add(bareAnchor);
    port.update();
    expect(meshes.at(-1)).toEqual([]);
    expect(anchors.at(-1)).toEqual([]);
  });

  it("parents what it creates where the app asked", async () => {
    const world = createFakeWorld();
    const parent = createFakeEntity();
    const port = new IWSDKWorldSensingPort(asWorld(world), { parent: parent as never });
    port.observe(recordingHost().host);

    await port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] });
    expect(world.created.at(-1)?.parent).toBe(parent);

    port.startHitTest({ id: "pointer", space: "viewer" });
    expect(world.created.at(-1)?.parent).toBe(parent);
  });

  it("reports an anchor as tracked only once IWSDK has attached it", () => {
    const { world, port, anchors } = setup();
    const entity = placed(0, 0, -1);
    entity.addComponent(XRAnchor);
    port.setDetection(ALL);
    world.entitiesWith(XRAnchor).add(entity);
    port.update();
    expect(anchors.at(-1)?.[0]?.tracked).toBe(false);

    entity.setValue(XRAnchor, "attached", true);
    port.update();
    expect(anchors.at(-1)?.[0]?.tracked).toBe(true);
  });

  it("makes an anchor by making an entity, which is how IWSDK anchors things", async () => {
    const { world, port } = setup();
    const id = await port.createAnchor({ position: [1, 2, 3], orientation: [0, 0, 0, 1] });
    expect(id).not.toBeNull();

    const created = world.created.at(-1);
    expect(created?.hasComponent(XRAnchor)).toBe(true);
    expect(created?.object3D?.position.toArray()).toEqual([1, 2, 3]);

    port.removeAnchor(id ?? "");
    expect(created?.destroyed).toBe(true);
    // Removing it twice, or removing something else, is not an error.
    port.removeAnchor(id ?? "");
    port.removeAnchor("world-999");
  });

  it("says so when the entity it made has nowhere to be", async () => {
    const world = createFakeWorld();
    // A world whose entities carry no transform is not a world that can anchor.
    world.createTransformEntity = () => createFakeEntity();
    const port = new IWSDKWorldSensingPort(asWorld(world));
    const { host, reports } = recordingHost();
    port.observe(host);

    await expect(
      port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
    ).resolves.toBeNull();
    expect(reports.at(-1)?.detail).toContain("no transform");
  });
});

describe("hit testing", () => {
  it("becomes an entity IWSDK's raycast system drives", () => {
    const { world, port, hits, reports } = setup();
    port.startHitTest({ id: "pointer", space: "right" });

    expect(world.registeredSystems).toContain(EnvironmentRaycastSystem);
    const target = world.created.at(-1);
    expect(target?.components.get(EnvironmentRaycastTarget)?.["space"]).toBe(RaycastSpace.Right);
    expect(reports.at(-1)?.state).toBe("pending");

    // No hit yet: the app is told there is nothing rather than left guessing.
    port.setDetection(ALL);
    port.update();
    expect(hits.at(-1)).toEqual({ id: "pointer", hits: [] });

    target?.setValue(EnvironmentRaycastTarget, "xrHitTestResult", { hit: true });
    port.update();
    expect(hits.at(-1)?.hits).toHaveLength(1);
    expect(reports.at(-1)?.detail).toBe("hitting the room");

    port.stopHitTest("pointer");
    expect(target?.destroyed).toBe(true);
    port.stopHitTest("pointer");
  });

  it("maps every ray source IWSDK has one for", () => {
    const { world, port } = setup();
    port.startHitTest({ id: "l", space: "left" });
    expect(world.created.at(-1)?.components.get(EnvironmentRaycastTarget)?.["space"]).toBe(
      RaycastSpace.Left,
    );
    port.startHitTest({ id: "v", space: "viewer" });
    expect(world.created.at(-1)?.components.get(EnvironmentRaycastTarget)?.["space"]).toBe(
      RaycastSpace.Viewer,
    );
  });
});

describe("turning it on and off", () => {
  it("says what it is waiting for, and what was not asked for", () => {
    const { port, reports } = setup();
    port.setDetection({ planes: true, meshes: false, anchors: false });
    const byFeature = new Map(reports.map((report) => [report.feature, report]));
    expect(byFeature.get("planes")?.detail).toContain("waiting for IWSDK");
    expect(byFeature.get("meshes")?.detail).toBe("detection is off");
  });

  it("reads only what was asked for", () => {
    const { world, port, planes, meshes, anchors } = setup();
    const surface = placed();
    surface.addComponent(XRPlane);
    const wall = placed();
    wall.addComponent(XRMesh);
    world.entitiesWith(XRPlane).add(surface);
    world.entitiesWith(XRMesh).add(wall);

    port.setDetection({ planes: true, meshes: false, anchors: false });
    port.update();
    expect(planes.at(-1)).toHaveLength(1);
    expect(meshes).toHaveLength(0);
    expect(anchors).toHaveLength(0);
  });

  it("empties everything when detection stops, and reads nothing after", () => {
    const { world, port, planes } = setup();
    const entity = placed();
    entity.addComponent(XRPlane);
    port.setDetection(ALL);
    world.entitiesWith(XRPlane).add(entity);
    port.update();
    expect(planes.at(-1)).toHaveLength(1);

    port.setDetection(null);
    expect(planes.at(-1)).toEqual([]);
    const before = planes.length;
    port.update();
    expect(planes).toHaveLength(before);
  });

  it("shares one query set with the world, so the system's entities arrive", () => {
    const { world, port } = setup();
    const entity = placed();
    entity.addComponent(XRPlane);
    // Added AFTER the port registered its query, which is the order the real
    // scene-understanding system works in.
    world.entitiesWith(XRPlane).add(entity);
    port.setDetection(ALL);
    port.update();
    expect(world.queryManager.registerQuery({ required: [XRPlane] }).entities.size).toBe(1);
  });

  it("goes quiet once the director lets go, and cleans up its entities", () => {
    const { world, port, planes, stop } = setup();
    port.startHitTest({ id: "pointer", space: "viewer" });
    const target = world.created.at(-1);
    stop();
    port.setDetection(ALL);
    port.update();
    expect(planes).toHaveLength(0);

    port.dispose();
    expect(target?.destroyed).toBe(true);
  });
});
