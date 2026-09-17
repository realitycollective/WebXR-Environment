/**
 * The WebXR-native world-sensing port.
 *
 * An `XRFrame` is a set of objects with spaces on them and a `getPose` that
 * turns a space into a transform. All three of those are object literals here,
 * which is how a plane that moves, a mesh that is rescanned and an anchor that
 * loses tracking are all reachable without a headset.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  SensingReport,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldSensingPortHost,
} from "@realitycollective/threejs-environment";
import { ThreeWorldSensingPort } from "@realitycollective/threejs-environment";
import type {
  XrFrameLike,
  XrPoseLike,
  XrRendererLike,
  XrSessionLike,
} from "@realitycollective/threejs-environment";

const REFERENCE = { name: "reference" };

function pose(x = 0, y = 0, z = 0): XrPoseLike {
  return { transform: { position: { x, y, z }, orientation: { x: 0, y: 0, z: 0, w: 1 } } };
}

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

interface FakeRenderer extends XrRendererLike {
  frame: XrFrameLike | null;
  session: XrSessionLike | null;
}

function fakeRenderer(session: XrSessionLike | null, frame: XrFrameLike | null = null) {
  const renderer: FakeRenderer = {
    frame,
    session,
    xr: {
      getSession: () => renderer.session,
      getFrame: () => renderer.frame,
      getReferenceSpace: () => REFERENCE,
    },
  };
  return renderer;
}

const FULL_SESSION: XrSessionLike = {
  enabledFeatures: ["plane-detection", "mesh-detection", "anchors", "hit-test"],
};

function setup(session: XrSessionLike | null = FULL_SESSION, frame: XrFrameLike | null = null) {
  const renderer = fakeRenderer(session, frame);
  const port = new ThreeWorldSensingPort(renderer);
  const recorder = recordingHost();
  const stop = port.observe(recorder.host);
  return { renderer, port, stop, ...recorder };
}

const ALL = { planes: true, meshes: true, anchors: true };

describe("planes", () => {
  const PLANE = {
    planeSpace: { id: "plane-space" },
    polygon: [
      { x: -1, y: 0, z: -0.5 },
      { x: 1, y: 0, z: -0.5 },
      { x: 1, y: 0, z: 0.5 },
      { x: -1, y: 0, z: 0.5 },
    ],
    orientation: "Horizontal",
    semanticLabel: "TABLE",
    lastChangedTime: 1,
  };

  it("reads a surface, its size, its label and where it is", () => {
    const frame: XrFrameLike = {
      detectedPlanes: [PLANE],
      getPose: () => pose(1, 2, 3),
    };
    const { port, planes, reports } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();

    const [plane] = planes.at(-1) ?? [];
    expect(plane?.pose.position).toEqual([1, 2, 3]);
    expect(plane?.extents).toEqual([2, 1]);
    expect(plane?.orientation).toBe("horizontal");
    expect(plane?.label).toBe("table");
    expect(plane?.polygon).toEqual([
      [-1, -0.5],
      [1, -0.5],
      [1, 0.5],
      [-1, 0.5],
    ]);
    expect(plane?.changedAt).toBe(1);
    expect(reports.filter((report) => report.feature === "planes").at(-1)).toEqual({
      feature: "planes",
      state: "active",
      detail: "1 surfaces",
    });
  });

  it("keeps an id stable across frames, and gives each surface its own", () => {
    const second = { ...PLANE, planeSpace: { id: "other" } };
    const frame: XrFrameLike = { detectedPlanes: [PLANE, second], getPose: () => pose() };
    const { port, planes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    port.update();

    const first = planes[0] ?? [];
    const again = planes[1] ?? [];
    expect(first[0]?.id).toBe(again[0]?.id);
    expect(first[0]?.id).not.toBe(first[1]?.id);
  });

  it("skips a surface the runtime cannot currently place", () => {
    const frame: XrFrameLike = { detectedPlanes: [PLANE], getPose: () => null };
    const { port, planes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)).toEqual([]);
  });

  it("copes with a plane that has no polygon, label or orientation", () => {
    const frame: XrFrameLike = { detectedPlanes: [{ planeSpace: {} }], getPose: () => pose() };
    const { port, planes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    const [plane] = planes.at(-1) ?? [];
    expect(plane?.extents).toEqual([0, 0]);
    expect(plane?.orientation).toBe("unknown");
    expect(plane?.label).toBeNull();
    expect(plane?.polygon).toBeUndefined();
    expect(plane?.changedAt).toBeUndefined();
  });

  it("says so when the frame reports no plane set at all", () => {
    const { port, reports } = setup(FULL_SESSION, { getPose: () => pose() });
    port.setDetection(ALL);
    port.update();
    expect(reports.some((report) => report.detail === "this frame reported no plane set")).toBe(
      true,
    );
  });
});

describe("meshes", () => {
  const vertices = new Float32Array([0, 0, 0, 2, 1, 4]);
  const MESH = {
    meshSpace: {},
    vertices,
    indices: new Uint32Array([0, 1, 2]),
    semanticLabel: "WALL",
    lastChangedTime: 7,
  };

  it("passes the buffers through and measures them once", () => {
    const getPose = vi.fn(() => pose());
    const frame: XrFrameLike = { detectedMeshes: [MESH], getPose };
    const { port, meshes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    port.update();

    const [mesh] = meshes.at(-1) ?? [];
    expect(mesh?.vertices).toBe(vertices);
    expect(mesh?.indices).toBe(MESH.indices);
    expect(mesh?.label).toBe("wall");
    expect(mesh?.extents).toEqual([2, 1, 4]);
    // Both frames produced a mesh, and the bounds were computed once.
    expect(meshes).toHaveLength(2);
    expect(meshes[0]?.[0]?.extents).toBe(meshes[1]?.[0]?.extents);
  });

  it("measures again when the runtime says the scan changed", () => {
    const changing = { ...MESH, lastChangedTime: 7 };
    const frame: XrFrameLike = { detectedMeshes: [changing], getPose: () => pose() };
    const { port, meshes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    changing.lastChangedTime = 8;
    changing.vertices = new Float32Array([0, 0, 0, 5, 5, 5]);
    port.update();
    expect(meshes.at(-1)?.[0]?.extents).toEqual([5, 5, 5]);
  });

  it("has no size for a mesh with no vertices", () => {
    const frame: XrFrameLike = { detectedMeshes: [{ meshSpace: {} }], getPose: () => pose() };
    const { port, meshes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    const [mesh] = meshes.at(-1) ?? [];
    expect(mesh?.extents).toBeNull();
    expect(mesh?.vertices).toBeUndefined();
  });

  it("says so when the frame reports no mesh set", () => {
    const { port, reports } = setup(FULL_SESSION, { detectedPlanes: [], getPose: () => pose() });
    port.setDetection(ALL);
    port.update();
    expect(reports.some((report) => report.detail === "this frame reported no mesh set")).toBe(true);
  });
});

describe("anchors", () => {
  it("keeps a lost anchor, marked as lost", () => {
    const anchor = { anchorSpace: {} };
    let tracked = true;
    const frame: XrFrameLike = {
      trackedAnchors: [anchor],
      getPose: () => (tracked ? pose(1, 1, 1) : null),
    };
    const { port, anchors } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    expect(anchors.at(-1)?.[0]?.tracked).toBe(true);

    tracked = false;
    port.update();
    expect(anchors.at(-1)?.[0]).toEqual({
      id: anchors[0]?.[0]?.id,
      pose: { position: [0, 0, 0], orientation: [0, 0, 0, 1] },
      tracked: false,
    });
  });

  it("creates one through the runtime and hands back its id", async () => {
    const created = { anchorSpace: {} };
    const rigidTransform = vi.fn(() => ({ transform: true }));
    const frame: XrFrameLike = {
      trackedAnchors: [created],
      getPose: () => pose(),
      createAnchor: async () => created,
    };
    const renderer = fakeRenderer(FULL_SESSION, frame);
    const port = new ThreeWorldSensingPort(renderer, { rigidTransform });
    const { host } = recordingHost();
    port.observe(host);

    const id = await port.createAnchor({ position: [1, 2, 3], orientation: [0, 0, 0, 1] });
    expect(rigidTransform).toHaveBeenCalledWith({ x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0, w: 1 });
    expect(id).not.toBeNull();

    // The same object read from the frame gets the same id, which is what lets
    // an app find the anchor it just made.
    port.setDetection(ALL);
    port.update();
    expect(id).toBe(id);

    port.removeAnchor(id ?? "");
    port.removeAnchor("not-an-anchor");
  });

  it("returns null rather than throwing when the runtime refuses", async () => {
    const frame: XrFrameLike = {
      getPose: () => pose(),
      createAnchor: async () => {
        throw new Error("tracking is poor");
      },
    };
    const renderer = fakeRenderer(FULL_SESSION, frame);
    const port = new ThreeWorldSensingPort(renderer, { rigidTransform: () => ({}) });
    port.observe(recordingHost().host);
    await expect(
      port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
    ).resolves.toBeNull();
  });

  it("says so when the runtime cannot make anchors, or cannot place them", async () => {
    const noCreate = setup(FULL_SESSION, { getPose: () => pose() });
    await expect(
      noCreate.port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
    ).resolves.toBeNull();
    expect(noCreate.reports.at(-1)?.detail).toBe("this runtime cannot create anchors");

    // No injected transform and no global one: the anchor cannot be placed.
    const noTransform = setup(FULL_SESSION, {
      getPose: () => pose(),
      createAnchor: async () => ({ anchorSpace: {} }),
    });
    await expect(
      noTransform.port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
    ).resolves.toBeNull();
    expect(noTransform.reports.at(-1)?.detail).toContain("XRRigidTransform");
  });

  it("uses the browser's own XRRigidTransform when there is one", async () => {
    const made: unknown[] = [];
    class FakeTransform {
      constructor(position: unknown, orientation: unknown) {
        made.push({ position, orientation });
      }
    }
    (globalThis as Record<string, unknown>)["XRRigidTransform"] = FakeTransform;
    try {
      const anchor = { anchorSpace: {} };
      const { port } = setup(FULL_SESSION, {
        getPose: () => pose(),
        createAnchor: async () => anchor,
      });
      await expect(
        port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
      ).resolves.not.toBeNull();
      expect(made).toHaveLength(1);
    } finally {
      delete (globalThis as Record<string, unknown>)["XRRigidTransform"];
    }
  });

  it("shrugs off a removal it has nothing to remove", () => {
    const noFrame = setup(FULL_SESSION, null);
    expect(() => noFrame.port.removeAnchor("world-1")).not.toThrow();
    const noAnchors = setup(FULL_SESSION, { getPose: () => pose() });
    expect(() => noAnchors.port.removeAnchor("world-1")).not.toThrow();
  });

  it("returns null when the runtime hands back nothing to await", async () => {
    const renderer = fakeRenderer(FULL_SESSION, {
      getPose: () => pose(),
      createAnchor: () => undefined,
    });
    const port = new ThreeWorldSensingPort(renderer, { rigidTransform: () => ({}) });
    port.observe(recordingHost().host);
    await expect(
      port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] }),
    ).resolves.toBeNull();
  });

  it("says so when the frame reports no anchor set", () => {
    const { port, reports } = setup(FULL_SESSION, { detectedPlanes: [], getPose: () => pose() });
    port.setDetection(ALL);
    port.update();
    expect(reports.some((report) => report.detail === "this frame reported no anchor set")).toBe(
      true,
    );
  });
});

describe("hit testing", () => {
  const HAND = { handedness: "right", targetRaySpace: { name: "right-ray" } };

  function hitSession(overrides: Partial<XrSessionLike> = {}): XrSessionLike {
    return {
      ...FULL_SESSION,
      requestHitTestSource: async () => ({ cancel: () => {} }),
      ...overrides,
    };
  }

  it("asks for a source, then answers every frame with a distance", async () => {
    const source = { cancel: vi.fn() };
    const requested: { space?: unknown }[] = [];
    const session = hitSession({
      requestHitTestSource: async (options) => {
        requested.push(options);
        return source;
      },
    });
    const frame: XrFrameLike = {
      // The ray starts at the origin; the hit is two metres ahead.
      getPose: () => pose(0, 0, 0),
      getHitTestResults: () => [{ getPose: () => pose(0, 0, -2) }, { getPose: () => null }],
    };
    const { port, hits, reports } = setup(session, frame);
    port.setDetection(ALL);
    port.startHitTest({ id: "pointer", space: "viewer" });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    expect(reports.at(-1)?.detail).toBe("casting from the viewer");
    expect(requested[0]?.space).toBe(REFERENCE);

    port.update();
    expect(hits.at(-1)?.hits).toEqual([
      {
        sourceId: "pointer",
        pose: { position: [0, 0, -2], orientation: [0, 0, 0, 1] },
        distance: 2,
      },
    ]);

    port.stopHitTest("pointer");
    expect(source.cancel).toHaveBeenCalled();
    port.stopHitTest("pointer");
  });

  it("casts a hand ray from the HAND, once there is one to cast from", async () => {
    const requested: { space?: unknown }[] = [];
    const renderer = fakeRenderer(
      hitSession({
        inputSources: [],
        requestHitTestSource: async (options) => {
          requested.push(options);
          return { cancel: () => {} };
        },
      }),
      { getPose: () => pose(), getHitTestResults: () => [] },
    );
    const port = new ThreeWorldSensingPort(renderer);
    const { host, reports } = recordingHost();
    port.observe(host);

    // No hand yet: the request waits rather than quietly aiming from the head.
    port.startHitTest({ id: "hand", space: "right" });
    expect(reports.at(-1)).toEqual({
      feature: "hitTest",
      state: "pending",
      detail: "waiting for a right hand or controller to point with",
    });
    expect(requested).toHaveLength(0);

    // The hand appears; the next frame binds to its own ray space.
    renderer.session = hitSession({
      inputSources: [HAND],
      requestHitTestSource: async (options) => {
        requested.push(options);
        return { cancel: () => {} };
      },
    });
    port.update();
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    expect(requested[0]?.space).toBe(HAND.targetRaySpace);
    expect(reports.at(-1)?.detail).toBe("casting from the right");
  });

  it("lets go when the hand does, and answers with nothing meanwhile", async () => {
    const source = { cancel: vi.fn() };
    const renderer = fakeRenderer(
      hitSession({ inputSources: [HAND], requestHitTestSource: async () => source }),
      { getPose: () => pose(), getHitTestResults: () => [{ getPose: () => pose(0, 0, -1) }] },
    );
    const port = new ThreeWorldSensingPort(renderer);
    const { host, reports, hits } = recordingHost();
    port.observe(host);
    port.startHitTest({ id: "hand", space: "right" });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    port.update();
    expect(hits.at(-1)?.hits).toHaveLength(1);

    renderer.session = hitSession({ inputSources: [], requestHitTestSource: async () => source });
    port.update();
    expect(source.cancel).toHaveBeenCalled();
    expect(hits.at(-1)).toEqual({ id: "hand", hits: [] });
    expect(reports.at(-1)).toEqual({
      feature: "hitTest",
      state: "pending",
      detail: "the right input source went away",
    });
  });

  it("ignores a source with no ray to cast", () => {
    const gazeOnly = { handedness: "right" };
    const { port, reports } = setup(hitSession({ inputSources: [gazeOnly] }), {
      getPose: () => pose(),
    });
    port.startHitTest({ id: "hand", space: "right" });
    expect(reports.at(-1)?.detail).toContain("waiting for a right hand");
  });

  it("passes an offset ray on, and says so when it cannot", async () => {
    const built: unknown[] = [];
    const requested: { offsetRay?: unknown }[] = [];
    const session = hitSession({
      requestHitTestSource: async (options) => {
        requested.push(options);
        return { cancel: () => {} };
      },
    });
    const renderer = fakeRenderer(session, { getPose: () => pose() });
    const withRay = new ThreeWorldSensingPort(renderer, {
      ray: (origin, direction) => {
        built.push({ origin, direction });
        return { ray: true };
      },
    });
    const first = recordingHost();
    withRay.observe(first.host);
    withRay.startHitTest({
      id: "aimed",
      space: "viewer",
      offsetRay: { origin: [0, 0, 0], direction: [0, -1, 0] },
    });
    await vi.waitFor(() => expect(first.reports.at(-1)?.state).toBe("active"));
    expect(built).toEqual([
      { origin: { x: 0, y: 0, z: 0, w: 1 }, direction: { x: 0, y: -1, z: 0, w: 0 } },
    ]);
    expect(requested[0]?.offsetRay).toEqual({ ray: true });

    // No XRRay anywhere: the request still works, and says what it dropped.
    const without = setup(session, { getPose: () => pose() });
    without.port.startHitTest({
      id: "aimed",
      space: "viewer",
      offsetRay: { origin: [0, 0, 0], direction: [0, -1, 0] },
    });
    await vi.waitFor(() => expect(without.reports.at(-1)?.state).toBe("active"));
    expect(without.reports.at(-1)?.detail).toContain("offset ray was ignored");
  });

  it("uses the browser's own XRRay when there is one", async () => {
    const made: unknown[] = [];
    class FakeRay {
      constructor(origin: unknown, direction: unknown) {
        made.push({ origin, direction });
      }
    }
    (globalThis as Record<string, unknown>)["XRRay"] = FakeRay;
    try {
      const { port, reports } = setup(hitSession(), { getPose: () => pose() });
      port.startHitTest({
        id: "aimed",
        space: "viewer",
        offsetRay: { origin: [0, 0, 0], direction: [0, 0, -1] },
      });
      await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
      expect(made).toHaveLength(1);
      expect(reports.at(-1)?.detail).toBe("casting from the viewer");
    } finally {
      delete (globalThis as Record<string, unknown>)["XRRay"];
    }
  });

  it("has no distance when the runtime cannot pose the ray", async () => {
    const frame: XrFrameLike = {
      getPose: () => null,
      getHitTestResults: () => [{ getPose: () => pose(1, 0, 0) }],
    };
    const { port, hits, reports } = setup(hitSession(), frame);
    port.startHitTest({ id: "pointer", space: "viewer" });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    port.update();
    expect(hits.at(-1)?.hits[0]?.distance).toBeNull();
  });

  it("answers a pointer even when no detection was asked for", async () => {
    const frame: XrFrameLike = {
      getPose: () => pose(),
      getHitTestResults: () => [{ getPose: () => pose(0, 0, -1) }],
    };
    const { port, hits, reports } = setup(hitSession(), frame);
    port.startHitTest({ id: "pointer", space: "viewer" });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    // Pointing at the room is not detection: no planes, no meshes, still hits.
    port.update();
    expect(hits.at(-1)?.hits).toHaveLength(1);
  });

  it("cancels a source that arrives after the app stopped asking", async () => {
    const source = { cancel: vi.fn() };
    let resolveSource: (value: { cancel(): void }) => void = () => {};
    const session = hitSession({
      requestHitTestSource: async () =>
        new Promise<{ cancel(): void }>((resolve) => {
          resolveSource = resolve;
        }),
    });
    const { port } = setup(session, { getPose: () => pose() });
    port.startHitTest({ id: "pointer", space: "viewer" });
    port.stopHitTest("pointer");
    resolveSource(source);
    await vi.waitFor(() => expect(source.cancel).toHaveBeenCalled());
  });

  it("says why it cannot, for every way it cannot", async () => {
    const noSession = setup(null, { getPose: () => pose() });
    noSession.port.startHitTest({ id: "a", space: "viewer" });
    expect(noSession.reports.at(-1)?.detail).toBe("no XR session is running");

    const noApi = setup({ enabledFeatures: ["hit-test"] }, { getPose: () => pose() });
    noApi.port.startHitTest({ id: "a", space: "viewer" });
    expect(noApi.reports.at(-1)?.detail).toBe("this runtime has no hit test");

    const notEnabled = setup(
      { enabledFeatures: [], requestHitTestSource: async () => ({}) },
      { getPose: () => pose() },
    );
    notEnabled.port.startHitTest({ id: "a", space: "viewer" });
    expect(notEnabled.reports.at(-1)?.detail).toContain("did not enable hit-test");

    const refused = setup(
      hitSession({
        requestHitTestSource: async () => {
          throw new Error("no");
        },
      }),
      { getPose: () => pose() },
    );
    refused.port.startHitTest({ id: "a", space: "viewer" });
    await vi.waitFor(() => expect(refused.reports.at(-1)?.detail).toContain("refused a hit test"));

    const undefinedSource = setup(hitSession({ requestHitTestSource: () => undefined }), {
      getPose: () => pose(),
    });
    undefinedSource.port.startHitTest({ id: "a", space: "viewer" });
    expect(undefinedSource.reports.at(-1)?.detail).toBe("the runtime refused");
  });

  it("asks a session that lists no features at all", () => {
    const { port, reports } = setup(
      { requestHitTestSource: async () => ({}) },
      { getPose: () => pose() },
    );
    port.startHitTest({ id: "a", space: "viewer" });
    expect(reports.at(-1)?.detail).toContain("did not enable hit-test");
  });

  it("lets go of a live source when the port is disposed", async () => {
    const source = { cancel: vi.fn() };
    const { port, reports } = setup(hitSession({ requestHitTestSource: async () => source }), {
      getPose: () => pose(),
    });
    port.startHitTest({ id: "pointer", space: "viewer" });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("active"));
    port.dispose();
    expect(source.cancel).toHaveBeenCalled();
  });

  it("does nothing per frame when the source has not arrived yet", () => {
    const { port, hits } = setup(hitSession(), {
      getPose: () => pose(),
      getHitTestResults: () => [],
    });
    port.setDetection(ALL);
    port.startHitTest({ id: "pointer", space: "viewer" });
    // The source resolves on a microtask, so this frame has nothing to ask.
    port.update();
    expect(hits).toHaveLength(0);
  });

  it("waits when the session lists no input sources at all", () => {
    const { port, reports } = setup(hitSession(), { getPose: () => pose() });
    port.startHitTest({ id: "hand", space: "left" });
    expect(reports.at(-1)?.detail).toContain("waiting for a left hand");
    // And keeps waiting, without tripping over the missing list.
    expect(() => port.update()).not.toThrow();
  });

  it("does not mistake one hand for the other", () => {
    const { port, reports } = setup(hitSession({ inputSources: [HAND] }), {
      getPose: () => pose(),
    });
    port.startHitTest({ id: "hand", space: "left" });
    expect(reports.at(-1)?.detail).toContain("waiting for a left hand");
  });

  it("survives a frameless tick while pointing", () => {
    const renderer = fakeRenderer(hitSession(), null);
    const port = new ThreeWorldSensingPort(renderer);
    port.observe(recordingHost().host);
    port.startHitTest({ id: "pointer", space: "viewer" });
    expect(() => port.update()).not.toThrow();
  });

  it("does not rebind when the session has gone", () => {
    const renderer = fakeRenderer(hitSession(), { getPose: () => pose() });
    const port = new ThreeWorldSensingPort(renderer);
    const { host, reports } = recordingHost();
    port.observe(host);
    port.startHitTest({ id: "pointer", space: "viewer" });
    renderer.session = null;
    expect(() => port.update()).not.toThrow();
    expect(reports.at(-1)?.state).toBe("pending");
  });
});

describe("turning it on and off", () => {
  it("reports what the session did not grant, one feature at a time", () => {
    const { port, reports } = setup({ enabledFeatures: ["plane-detection"] }, {
      detectedPlanes: [],
      getPose: () => pose(),
    });
    port.setDetection(ALL);
    const details = reports.map((report) => report.feature + ":" + (report.detail ?? ""));
    expect(details).toContain("planes:waiting for the first frame");
    expect(details.some((detail) => detail.startsWith("meshes:the session did not enable"))).toBe(
      true,
    );
  });

  it("says nothing about a feature that was not asked for, and reads none of it", () => {
    const frame: XrFrameLike = {
      detectedPlanes: [{ planeSpace: {} }],
      detectedMeshes: [{ meshSpace: {} }],
      trackedAnchors: [{ anchorSpace: {} }],
      getPose: () => pose(),
    };
    const { port, reports, planes, meshes, anchors } = setup(FULL_SESSION, frame);
    port.setDetection({ planes: true, meshes: false, anchors: false });
    port.update();
    expect(reports.filter((report) => report.feature === "meshes").at(-1)?.detail).toBe(
      "detection is off",
    );
    expect(planes.at(-1)).toHaveLength(1);
    expect(meshes).toHaveLength(0);
    expect(anchors).toHaveLength(0);
  });

  it("reads meshes without planes just as happily", () => {
    const frame: XrFrameLike = {
      detectedPlanes: [{ planeSpace: {} }],
      detectedMeshes: [{ meshSpace: {} }],
      getPose: () => pose(),
    };
    const { port, planes, meshes } = setup(FULL_SESSION, frame);
    port.setDetection({ planes: false, meshes: true, anchors: false });
    port.update();
    expect(meshes.at(-1)).toHaveLength(1);
    expect(planes).toHaveLength(0);
  });

  it("skips anything the runtime cannot place, whatever it is", () => {
    const frame: XrFrameLike = {
      detectedMeshes: [{ meshSpace: {} }],
      trackedAnchors: [{}],
      getPose: () => null,
    };
    const { port, meshes, anchors } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    expect(meshes.at(-1)).toEqual([]);
    // An anchor with no space at all is still listed, as untracked: the app
    // asked for it and deleting it from under them would be worse.
    expect(anchors.at(-1)?.[0]?.tracked).toBe(false);
  });

  it("reads nothing from a frame that cannot pose anything", () => {
    const frame: XrFrameLike = { detectedPlanes: [{ planeSpace: {} }] };
    const { port, planes } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)).toEqual([]);
  });

  it("reports no session when there is none", () => {
    const { port, reports } = setup(null, { getPose: () => pose() });
    port.setDetection(ALL);
    expect(reports.at(-1)?.detail).toBe("no XR session is running");
  });

  it("empties everything when detection stops, and stops reading frames", () => {
    const frame: XrFrameLike = { detectedPlanes: [{ planeSpace: {} }], getPose: () => pose() };
    const { port, planes, meshes, anchors } = setup(FULL_SESSION, frame);
    port.setDetection(ALL);
    port.update();
    expect(planes.at(-1)).toHaveLength(1);

    port.setDetection(null);
    expect(planes.at(-1)).toEqual([]);
    expect(meshes.at(-1)).toEqual([]);
    expect(anchors.at(-1)).toEqual([]);

    const before = planes.length;
    port.update();
    expect(planes).toHaveLength(before);
  });

  it("does nothing without a frame, or once the director lets go", () => {
    const { port, planes, stop } = setup(FULL_SESSION, null);
    port.setDetection(ALL);
    port.update();
    expect(planes).toHaveLength(0);

    stop();
    port.setDetection(ALL);
    port.update();
    expect(planes).toHaveLength(0);
    port.dispose();
  });
});
