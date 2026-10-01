import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_HOST_GLOBAL } from "../src/native-types.js";
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  SensingReport,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldPose,
} from "@realitycollective/webxr-environment";
import { NativeWorldSensingPort } from "../src/world-sensing-port.js";
import { createFakeSensingHost } from "./helpers.js";

const DETECTION: ResolvedWorldDetection = { planes: true, meshes: false, anchors: false };
const POSE: WorldPose = { position: [0, 0, 0], orientation: [0, 0, 0, 1] };
const HIT_REQUEST: HitTestRequest = { id: "pointer", space: "right" };

function noopHost() {
  return {
    planes: () => {},
    meshes: () => {},
    anchors: () => {},
    hits: () => {},
    report: () => {},
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL];
});

describe("NativeWorldSensingPort", () => {
  it("forwards every member when the host has all five", async () => {
    const host = createFakeSensingHost();
    const port = new NativeWorldSensingPort(host);

    port.setDetection?.(DETECTION);
    port.startHitTest?.(HIT_REQUEST);
    port.stopHitTest?.("pointer");
    const anchorId = await port.createAnchor?.(POSE);
    port.removeAnchor?.("anchor-1");

    expect(host.setDetection).toHaveBeenCalledWith(DETECTION);
    expect(host.startHitTest).toHaveBeenCalledWith(HIT_REQUEST);
    expect(host.stopHitTest).toHaveBeenCalledWith("pointer");
    expect(anchorId).toBe("anchor-1");
    expect(host.removeAnchor).toHaveBeenCalledWith("anchor-1");
  });

  it("omits each forwarding member the host lacks, one at a time", () => {
    expect(new NativeWorldSensingPort(createFakeSensingHost({ setDetection: false })).setDetection).toBeUndefined();
    expect(new NativeWorldSensingPort(createFakeSensingHost({ startHitTest: false })).startHitTest).toBeUndefined();
    expect(new NativeWorldSensingPort(createFakeSensingHost({ stopHitTest: false })).stopHitTest).toBeUndefined();
    expect(new NativeWorldSensingPort(createFakeSensingHost({ createAnchor: false })).createAnchor).toBeUndefined();
    expect(new NativeWorldSensingPort(createFakeSensingHost({ removeAnchor: false })).removeAnchor).toBeUndefined();
  });

  it("omits every forwarding member when there is no sensing slice at all", () => {
    const port = new NativeWorldSensingPort(undefined);
    expect(port.setDetection).toBeUndefined();
    expect(port.startHitTest).toBeUndefined();
    expect(port.stopHitTest).toBeUndefined();
    expect(port.createAnchor).toBeUndefined();
    expect(port.removeAnchor).toBeUndefined();
  });

  it("wires all five push channels when the host has them", () => {
    const host = createFakeSensingHost();
    const port = new NativeWorldSensingPort(host);
    const planes: WorldPlane[][] = [];
    const meshes: WorldMesh[][] = [];
    const anchors: WorldAnchor[][] = [];
    const hits: [string, WorldHit[]][] = [];
    const reports: SensingReport[] = [];

    port.observe({
      planes: (value) => planes.push([...value]),
      meshes: (value) => meshes.push([...value]),
      anchors: (value) => anchors.push([...value]),
      hits: (sourceId, value) => hits.push([sourceId, [...value]]),
      report: (report) => reports.push(report),
    });

    const plane: WorldPlane = {
      id: "p1",
      pose: POSE,
      extents: [1, 1],
      orientation: "horizontal",
      label: null,
    };
    const mesh: WorldMesh = { id: "m1", pose: POSE, extents: null, label: null };
    const anchor: WorldAnchor = { id: "a1", pose: POSE, tracked: true };
    const hit: WorldHit = { sourceId: "pointer", pose: POSE, distance: 1 };
    const report: SensingReport = { feature: "planes", state: "active" };

    host.emitPlanes([plane]);
    host.emitMeshes([mesh]);
    host.emitAnchors([anchor]);
    host.emitHits("pointer", [hit]);
    host.emitSensingReport(report);

    expect(planes).toEqual([[plane]]);
    expect(meshes).toEqual([[mesh]]);
    expect(anchors).toEqual([[anchor]]);
    expect(hits).toEqual([["pointer", [hit]]]);
    expect(reports).toEqual([report]);
  });

  it("wires none of the five push channels when the sensing slice has none, even though it exists", () => {
    const host = createFakeSensingHost({
      onPlanes: false,
      onMeshes: false,
      onAnchors: false,
      onHits: false,
      onSensingReport: false,
    });
    const port = new NativeWorldSensingPort(host);
    const stop = port.observe(noopHost());

    expect(host.onPlanes).toBeUndefined();
    expect(host.onMeshes).toBeUndefined();
    expect(host.onAnchors).toBeUndefined();
    expect(host.onHits).toBeUndefined();
    expect(host.onSensingReport).toBeUndefined();
    expect(() => stop()).not.toThrow();
  });

  it("stops listening once the returned unsubscribe runs", () => {
    const host = createFakeSensingHost();
    const port = new NativeWorldSensingPort(host);
    const reports: SensingReport[] = [];
    const stop = port.observe({ ...noopHost(), report: (report) => reports.push(report) });

    stop();
    host.emitSensingReport({ feature: "planes", state: "active" });
    expect(reports).toEqual([]);
  });

  it("wires nothing, and returns a no-op unsubscribe, when there is no sensing slice", () => {
    const port = new NativeWorldSensingPort(undefined);
    const stop = port.observe(noopHost());
    expect(() => stop()).not.toThrow();
  });
});
