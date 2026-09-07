/**
 * The world-sensing director.
 *
 * The behaviour worth pinning is the diffing: a port hands over whole sets, an
 * app is told what appeared, moved and went away, and "still there, unchanged"
 * is silence rather than a change event every frame.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  WorldAnchor,
  WorldChange,
  WorldMesh,
  WorldPlane,
  WorldPose,
  WorldSensingPort,
  WorldSensingPortHost,
} from "@realitycollective/webxr-environment";
import {
  ALL_WORLD_DETECTION,
  resolveWorldDetection,
  WorldSensingDirector,
  worldEntryChanged,
  WORLD_FEATURES,
} from "@realitycollective/webxr-environment";

const ORIGIN: WorldPose = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };

function plane(id: string, overrides: Partial<WorldPlane> = {}): WorldPlane {
  return {
    id,
    pose: ORIGIN,
    extents: [1, 1],
    orientation: "horizontal",
    label: "table",
    ...overrides,
  };
}

function mesh(id: string, overrides: Partial<WorldMesh> = {}): WorldMesh {
  return { id, pose: ORIGIN, extents: [1, 1, 1], label: null, ...overrides };
}

function anchor(id: string, tracked = true): WorldAnchor {
  return { id, pose: ORIGIN, tracked };
}

/** A port that does everything, so the director's own rules are what fails. */
class FakeWorldPort implements WorldSensingPort {
  host: WorldSensingPortHost | undefined;
  readonly detections: (ResolvedWorldDetection | null)[] = [];
  readonly started: HitTestRequest[] = [];
  readonly stopped: string[] = [];
  readonly removed: string[] = [];
  readonly ticks: number[] = [];
  unobserved = false;
  disposed = false;
  anchorId: string | null = "anchor-1";

  observe(host: WorldSensingPortHost): () => void {
    this.host = host;
    return () => {
      this.unobserved = true;
    };
  }
  setDetection(detection: ResolvedWorldDetection | null): void {
    this.detections.push(detection);
  }
  startHitTest(request: HitTestRequest): void {
    this.started.push(request);
  }
  stopHitTest(id: string): void {
    this.stopped.push(id);
  }
  async createAnchor(): Promise<string | null> {
    return this.anchorId;
  }
  removeAnchor(id: string): void {
    this.removed.push(id);
  }
  update(deltaMs: number): void {
    this.ticks.push(deltaMs);
  }
  dispose(): void {
    this.disposed = true;
  }
}

/** A port with only what the contract demands, to prove the rest is optional. */
class BareWorldPort implements WorldSensingPort {
  observe(): void {}
}

function setup(options: ConstructorParameters<typeof WorldSensingDirector>[1] = {}) {
  const port = new FakeWorldPort();
  const director = new WorldSensingDirector(port, options);
  const changes: WorldChange[] = [];
  director.onChange((change) => changes.push(change));
  return { port, director, changes };
}

describe("asking for detection", () => {
  it("passes the resolved request on, defaulting everything to off", () => {
    const { port, director } = setup();
    director.setDetection({ planes: true });
    expect(port.detections).toEqual([{ planes: true, meshes: false, anchors: false }]);
    expect(director.detection).toEqual({ planes: true, meshes: false, anchors: false });

    director.setDetection(true);
    expect(port.detections.at(-1)).toEqual(ALL_WORLD_DETECTION);
  });

  it("does not repeat itself", () => {
    const { port, director } = setup();
    director.setDetection({ planes: true });
    director.setDetection({ planes: true, meshes: false });
    expect(port.detections).toHaveLength(1);
  });

  it("takes false and null as the same instruction, and forgets what it found", () => {
    const { port, director, changes } = setup({ detection: true });
    port.host?.planes([plane("a")]);
    expect(director.planes()).toHaveLength(1);

    director.setDetection(false);
    expect(port.detections.at(-1)).toBeNull();
    expect(director.planes()).toHaveLength(0);
    expect(changes.at(-1)).toEqual({
      feature: "planes",
      added: [],
      updated: [],
      removed: ["a"],
    });
  });

  it("drops only what was switched off", () => {
    const { port, director } = setup({ detection: true });
    port.host?.planes([plane("a")]);
    port.host?.meshes([mesh("m")]);

    director.setDetection({ planes: true });
    expect(director.planes()).toHaveLength(1);
    expect(director.meshes()).toHaveLength(0);
  });

  it("says so on a port that cannot detect anything", () => {
    const director = new WorldSensingDirector(new BareWorldPort());
    const seen = vi.fn();
    director.onSensing(seen);
    director.setDetection(true);

    expect(director.getSensing("planes")).toEqual({
      feature: "planes",
      state: "unsupported",
      detail: "this adapter cannot detect the room",
    });
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("says so when a port that cannot detect is asked to STOP, too", () => {
    const director = new WorldSensingDirector(new BareWorldPort(), { detection: true });
    director.setDetection(null);
    // Turning it off on a port that never had it still has to answer for all
    // three, because "off" is not a subset of anything.
    expect(director.getSensing("meshes").state).toBe("unsupported");
  });

  it("defaults every world feature to unsupported", () => {
    const { director } = setup();
    for (const feature of WORLD_FEATURES) {
      expect(director.getSensing(feature)).toEqual({ feature, state: "unsupported" });
    }
  });
});

describe("full sets in, diffs out", () => {
  it("reports what appeared, what moved and what went", () => {
    const { port, director, changes } = setup({ detection: true });

    port.host?.planes([plane("a"), plane("b")]);
    expect(changes.at(-1)).toEqual({
      feature: "planes",
      added: ["a", "b"],
      updated: [],
      removed: [],
    });

    // The same two planes again, unchanged, is silence.
    port.host?.planes([plane("a"), plane("b")]);
    expect(changes).toHaveLength(1);

    port.host?.planes([plane("a", { extents: [2, 2] })]);
    expect(changes.at(-1)).toEqual({
      feature: "planes",
      added: [],
      updated: ["a"],
      removed: ["b"],
    });
    expect(director.planes()[0]?.extents).toEqual([2, 2]);
  });

  it("keeps the three registries apart", () => {
    const { port, director, changes } = setup({ detection: true });
    port.host?.planes([plane("a")]);
    port.host?.meshes([mesh("m")]);
    port.host?.anchors([anchor("x")]);

    expect(director.planes()).toHaveLength(1);
    expect(director.meshes()).toHaveLength(1);
    expect(director.anchors()).toHaveLength(1);
    expect(changes.map((change) => change.feature)).toEqual(["planes", "meshes", "anchors"]);
  });

  it("finds planes by the host's own label", () => {
    const { port, director } = setup({ detection: true });
    port.host?.planes([plane("a"), plane("b", { label: "floor" }), plane("c", { label: null })]);
    expect(director.planesLabelled("TABLE").map((found) => found.id)).toEqual(["a"]);
    expect(director.planesLabelled("ceiling")).toHaveLength(0);
  });

  it("finds meshes by label as well as planes, and matches without case", () => {
    const { port, director } = setup({ detection: true });
    port.host?.planes([plane("p", { label: "wall" })]);
    port.host?.meshes([mesh("m", { label: "wall" }), mesh("n", { label: "table" })]);

    // A wall arrives as a mesh as often as a plane, so both sides answer.
    expect(director.meshesLabelled("WALL").map((found) => found.id)).toEqual(["m"]);
    expect(director.planesLabelled("wall").map((found) => found.id)).toEqual(["p"]);
    expect(director.meshesLabelled("ceiling")).toHaveLength(0);
  });

  it("notices an anchor losing tracking", () => {
    const { port, changes } = setup({ detection: true });
    port.host?.anchors([anchor("x")]);
    port.host?.anchors([anchor("x", false)]);
    expect(changes.at(-1)).toEqual({
      feature: "anchors",
      added: [],
      updated: ["x"],
      removed: [],
    });
  });

  it("stops listening when the app unsubscribes", () => {
    const { port, director } = setup({ detection: true });
    const seen = vi.fn();
    const stop = director.onChange(seen);
    port.host?.planes([plane("a")]);
    stop();
    port.host?.planes([plane("a"), plane("b")]);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe("worldEntryChanged", () => {
  it("trusts the host's own counter when there is one", () => {
    const first = plane("a", { changedAt: 1 });
    expect(worldEntryChanged(first, plane("a", { changedAt: 1, extents: [9, 9] }))).toBe(false);
    expect(worldEntryChanged(first, plane("a", { changedAt: 2 }))).toBe(true);
  });

  it("compares the description when there is not", () => {
    expect(worldEntryChanged(plane("a"), plane("a"))).toBe(false);
    expect(worldEntryChanged(plane("a"), plane("a", { label: "floor" }))).toBe(true);
    expect(
      worldEntryChanged(plane("a"), plane("a", { pose: { ...ORIGIN, position: [1, 0, 0] } })),
    ).toBe(true);
  });

  it("never walks a mesh's buffers", () => {
    const buffer = new Float32Array([0, 0, 0]);
    const before = mesh("m", { vertices: buffer });
    // The same buffer, refilled in place: not a change this can see, which is
    // exactly why a host that does that has to supply `changedAt`.
    buffer[0] = 5;
    expect(worldEntryChanged(before, mesh("m", { vertices: buffer }))).toBe(false);
    expect(worldEntryChanged(before, mesh("m"))).toBe(true);
    const indexed = mesh("m", { vertices: buffer, indices: new Uint16Array([0, 1, 2]) });
    expect(worldEntryChanged(indexed, mesh("m", { vertices: buffer }))).toBe(true);
    expect(
      worldEntryChanged(indexed, mesh("m", { vertices: buffer, indices: new Uint16Array([9]) })),
    ).toBe(false);
    expect(worldEntryChanged(mesh("m"), mesh("m", { extents: null }))).toBe(true);
  });
});

describe("hit testing", () => {
  const REQUEST: HitTestRequest = { id: "pointer", space: "right" };

  it("starts one source per id and reads its answers back", () => {
    const { port, director } = setup();
    director.startHitTest(REQUEST);
    expect(port.started).toEqual([REQUEST]);

    port.host?.hits("pointer", [{ sourceId: "pointer", pose: ORIGIN, distance: 1.5 }]);
    expect(director.hits("pointer")).toHaveLength(1);
    expect(director.hits()).toHaveLength(1);

    // Re-requesting the same id replaces the source rather than stacking one
    // per frame, which is what a moving hand would otherwise do.
    director.startHitTest({ ...REQUEST, space: "left" });
    expect(port.stopped).toEqual(["pointer"]);
    expect(port.started).toHaveLength(2);

    director.stopHitTest("pointer");
    expect(director.hits("pointer")).toEqual([]);
    director.stopHitTest("pointer");
    expect(port.stopped).toHaveLength(2);
  });

  it("drops an answer to a question nobody asked", () => {
    const { port, director } = setup();
    port.host?.hits("ghost", [{ sourceId: "ghost", pose: ORIGIN, distance: null }]);
    expect(director.hits("ghost")).toEqual([]);
  });

  it("says so on a port with no hit test", () => {
    const director = new WorldSensingDirector(new BareWorldPort());
    director.startHitTest(REQUEST);
    expect(director.getSensing("hitTest")).toEqual({
      feature: "hitTest",
      state: "unsupported",
      detail: "this adapter has no hit test",
    });
  });
});

describe("anchors", () => {
  it("hands back the id the runtime gave, and null when it refused", async () => {
    const { port, director } = setup({ detection: true });
    await expect(director.createAnchor(ORIGIN)).resolves.toBe("anchor-1");

    port.anchorId = null;
    await expect(director.createAnchor(ORIGIN)).resolves.toBeNull();

    director.removeAnchor("anchor-1");
    expect(port.removed).toEqual(["anchor-1"]);
  });

  it("turns anchor detection on rather than handing back a dead id", async () => {
    const { port, director } = setup({ detection: { planes: true } });
    expect(director.detection?.anchors).toBe(false);

    const id = await director.createAnchor(ORIGIN);
    expect(id).toBe("anchor-1");
    // Without this the app would hold an id that nothing ever updates, because
    // anchors only flow while anchor detection is on.
    expect(director.detection).toEqual({ planes: true, meshes: false, anchors: true });
    expect(port.detections.at(-1)).toEqual({ planes: true, meshes: false, anchors: true });
    expect(director.getSensing("anchors").detail).toContain("was turned on");

    port.host?.anchors([anchor("anchor-1")]);
    expect(director.anchors()).toHaveLength(1);
  });

  it("leaves detection alone when anchors were already wanted", async () => {
    const { port, director } = setup({ detection: true });
    await director.createAnchor(ORIGIN);
    expect(port.detections).toHaveLength(1);
  });

  it("says so on a port that cannot make them", async () => {
    const director = new WorldSensingDirector(new BareWorldPort());
    await expect(director.createAnchor(ORIGIN)).resolves.toBeNull();
    expect(director.getSensing("anchors").detail).toBe("this adapter cannot create anchors");
    // The optional port members are genuinely optional.
    expect(() => {
      director.removeAnchor("nothing");
      director.update(16);
      director.dispose();
    }).not.toThrow();
  });
});

describe("reports and lifecycle", () => {
  it("passes a port's reports on, once per change", () => {
    const { port, director } = setup();
    const seen = vi.fn();
    director.onSensing(seen);

    port.host?.report({ feature: "planes", state: "pending" });
    port.host?.report({ feature: "planes", state: "pending" });
    expect(seen).toHaveBeenCalledTimes(1);

    port.host?.report({ feature: "planes", state: "active", detail: "3 surfaces" });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(director.getSensing("planes").detail).toBe("3 surfaces");

    const stop = director.onSensing(vi.fn());
    stop();
    port.host?.report({ feature: "meshes", state: "active" });
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("ticks the port and stops at dispose", () => {
    const { port, director } = setup();
    director.startHitTest({ id: "pointer", space: "viewer" });
    director.update(16);
    expect(port.ticks).toEqual([16]);

    director.dispose();
    expect(port.unobserved).toBe(true);
    expect(port.disposed).toBe(true);
    // The standing request is retired, not left running on the host.
    expect(port.stopped).toEqual(["pointer"]);

    director.dispose();
    expect(port.stopped).toEqual(["pointer"]);

    director.update(16);
    expect(port.ticks).toEqual([16]);
    port.host?.planes([plane("a")]);
    port.host?.hits("pointer", []);
    port.host?.report({ feature: "planes", state: "active" });
    expect(director.planes()).toHaveLength(0);
    expect(director.getSensing("planes").state).toBe("unsupported");
  });

  it("refuses to be driven after disposal", () => {
    const { director } = setup();
    director.dispose();
    expect(() => director.setDetection(true)).toThrow("disposed");
  });

  it("resolves a spec the same way the director does", () => {
    expect(resolveWorldDetection({})).toEqual({ planes: false, meshes: false, anchors: false });
    expect(resolveWorldDetection({ meshes: true })).toEqual({
      planes: false,
      meshes: true,
      anchors: false,
    });
  });
});
