/**
 * The XR Blocks adapter.
 *
 * XR Blocks is not imported here, by the same rule the adapter follows: the
 * managers are described structurally, so a depth manager is an object with
 * options and two methods, and a lighting manager is an object with a light
 * and a probe. What is under test is the DECISIONS - what gets turned on, what
 * gets reported when it cannot be, and what the estimate becomes.
 */
import { describe, expect, it } from "vitest";
import { Scene } from "three";
import type {
  EnvironmentPortHost,
  EstimatedLighting,
  SensingReport,
  XBDepthLike,
  XBLightingLike,
} from "@realitycollective/xrblocks-environment";
import {
  createXRBlocksEnvironment,
  estimatedFromLighting,
  XRBlocksEnvironmentPort,
} from "@realitycollective/xrblocks-environment";

function recordingHost(): {
  host: EnvironmentPortHost;
  reports: SensingReport[];
  estimates: (EstimatedLighting | null)[];
} {
  const reports: SensingReport[] = [];
  const estimates: (EstimatedLighting | null)[] = [];
  return {
    reports,
    estimates,
    host: {
      report: (report) => reports.push(report),
      estimate: (lighting) => estimates.push(lighting),
    },
  };
}

interface FakeDepth extends XBDepthLike {
  clients: Set<object>;
  texture: unknown;
}

function fakeDepth(options: XBDepthLike["options"] = {}): FakeDepth {
  const depth: FakeDepth = {
    clients: new Set<object>(),
    texture: undefined,
    options: {
      enabled: true,
      occlusion: { enabled: false },
      depthTexture: { enabled: true },
      ...options,
    },
    resumeDepth: (client) => {
      depth.clients.add(client);
    },
    pauseDepth: (client) => {
      depth.clients.delete(client);
    },
    getTexture: () => depth.texture,
  };
  return depth;
}

function fakeLighting(options: XBLightingLike["options"] = { enabled: true }): XBLightingLike {
  return {
    options,
    dirLight: { color: { r: 1, g: 0.5, b: 0.25 }, intensity: 2, position: { x: 0, y: 20, z: 0 } },
    ambientLight: { x: 1, y: 0.5, z: 0.25 },
  };
}

function setup(context: Parameters<typeof createXRBlocksEnvironment>[1]) {
  const scene = new Scene();
  const port = new XRBlocksEnvironmentPort(scene, context);
  const { host, reports, estimates } = recordingHost();
  const stop = port.observe(host);
  return { scene, port, reports, estimates, stop };
}

describe("the three.js half", () => {
  it("comes through unchanged, because it is the same port underneath", () => {
    const scene = new Scene();
    const { director } = createXRBlocksEnvironment(scene, {}, {
      initial: {
        sky: { kind: "solid", colour: [1, 0, 0] },
        ibl: { kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] },
      },
    });
    expect(scene.background).not.toBeNull();
    expect(scene.environment).not.toBeNull();
    director.dispose();
  });
});

describe("depth occlusion", () => {
  it("registers as a depth client and turns the pass on", () => {
    const depth = fakeDepth({ occlusion: { enabled: false } });
    const { port, reports } = setup({ depth });

    port.applyOcclusion({ mode: "soft", scope: "all", softness: 0.6 });
    expect(depth.options?.occlusion?.enabled).toBe(true);
    expect(depth.options?.depthTexture?.applyGaussianBlur).toBe(true);
    expect(depth.options?.depthTexture?.constantKernel).toBe(true);
    expect(depth.clients.size).toBe(1);
    expect(reports.at(-1)).toEqual({
      feature: "occlusion",
      state: "pending",
      detail: "waiting for the first depth frame",
    });

    port.applyOcclusion(null);
    expect(depth.clients.size).toBe(0);
    expect(depth.options?.occlusion?.enabled).toBe(false);
    expect(reports.at(-1)?.detail).toBe("occlusion is off");
  });

  it("draws a hard edge without the blur", () => {
    const depth = fakeDepth();
    const { port } = setup({ depth });
    port.applyOcclusion({ mode: "hard", scope: "all" });
    expect(depth.options?.depthTexture?.applyGaussianBlur).toBe(false);
    expect(depth.options?.depthTexture?.constantKernel).toBe(false);
  });

  it("goes active when a depth texture appears, and back when it goes", () => {
    const depth = fakeDepth();
    const { port, reports } = setup({ depth });
    port.applyOcclusion({ mode: "soft", scope: "all" });

    port.update();
    expect(reports).toHaveLength(1);

    depth.texture = {};
    port.update();
    expect(reports.at(-2)).toEqual({ feature: "occlusion", state: "active" });
    expect(reports.at(-1)).toEqual({ feature: "depthTexture", state: "active" });

    depth.texture = undefined;
    port.update();
    expect(reports.at(-1)).toEqual({ feature: "depthTexture", state: "unavailable" });
  });

  it("says which option was never set", () => {
    const none = setup({});
    none.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(none.reports.at(-1)?.detail).toContain("without an XR Blocks depth manager");

    const off = setup({ depth: fakeDepth({ enabled: false }) });
    off.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(off.reports.at(-1)?.detail).toContain("depth.enabled");

    const noPass = setup({ depth: { options: { enabled: true } } });
    noPass.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(noPass.reports.at(-1)?.detail).toContain("depth.occlusion.enabled");
  });

  it("names what it could not honour rather than pretending", () => {
    const depth = fakeDepth({ usagePreference: ["gpu-optimized"] });
    const { port, reports } = setup({ depth });
    port.applyOcclusion({
      mode: "minmax-soft",
      scope: "tagged",
      source: { usage: "cpu-optimized" },
      updateFps: 15,
    });
    const detail = reports.at(-1)?.detail ?? "";
    expect(detail).toContain("minmax-soft is drawn as soft");
    expect(detail).toContain("everything that depth-tests");
    expect(detail).toContain("gpu-optimized");
    expect(detail).toContain("updateFps");
  });

  it("says nothing about a preference the app and the session agree on", () => {
    const depth = fakeDepth({ usagePreference: ["gpu-optimized"] });
    const { port, reports } = setup({ depth });
    port.applyOcclusion({ mode: "soft", scope: "all", source: { usage: "gpu-optimized" } });
    expect(reports.at(-1)?.detail).toBe("waiting for the first depth frame");
  });

  it("lets go of the depth client when the port is disposed", () => {
    const depth = fakeDepth();
    const { port } = setup({ depth });
    port.applyOcclusion({ mode: "soft", scope: "all" });
    port.dispose();
    expect(depth.clients.size).toBe(0);
  });

  it("turns off cleanly when it was never on", () => {
    const depth = fakeDepth();
    const { port, reports } = setup({ depth });
    port.applyOcclusion(null);
    expect(depth.clients.size).toBe(0);
    expect(reports.at(-1)?.detail).toBe("occlusion is off");
    port.update();
    expect(reports).toHaveLength(1);
  });
});

describe("light estimation", () => {
  it("reads the XR Blocks managers and hands over specs", () => {
    const lighting = fakeLighting();
    const { port, reports, estimates } = setup({ lighting });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(reports.at(-1)?.state).toBe("pending");

    port.update();
    expect(reports.at(-1)).toEqual({ feature: "lightEstimation", state: "active" });
    expect(estimates.at(-1)?.key).toEqual({
      colour: [1, 0.5, 0.25],
      intensity: 2,
      direction: [-0, -20, -0],
    });

    // A second reading updates without re-announcing.
    port.update();
    expect(estimates).toHaveLength(2);
    expect(reports.filter((r) => r.feature === "lightEstimation")).toHaveLength(2);
  });

  it("warns when XR Blocks is lighting the scene as well", () => {
    const lighting = fakeLighting({ enabled: true, useDirectionalLight: true });
    const { port, reports } = setup({ lighting });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    port.update();
    expect(reports.at(-1)?.detail).toContain("lighting the room twice");

    const probeOnly = setup({
      lighting: fakeLighting({ enabled: true, useAmbientSH: true }),
    });
    probeOnly.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    probeOnly.port.update();
    expect(probeOnly.reports.at(-1)?.detail).toContain("lighting the room twice");
  });

  it("stamps the shadow flag onto the measured key light", () => {
    const { port, estimates } = setup({ lighting: fakeLighting() });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: true });
    port.update();
    expect(estimates.at(-1)?.key?.castShadow).toBe(true);
  });

  it("waits for a manager that has measured something", () => {
    const { port, estimates } = setup({ lighting: { options: { enabled: true } } });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    port.update();
    expect(estimates).toHaveLength(0);
  });

  it("says which option was never set", () => {
    const none = setup({});
    none.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(none.reports.at(-1)?.detail).toContain("without an XR Blocks lighting manager");

    const off = setup({ lighting: { options: { enabled: false } } });
    off.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(off.reports.at(-1)?.detail).toContain("lighting.enabled");

    off.port.applyLightEstimation(null);
    expect(off.reports.at(-1)?.detail).toBe("light estimation is off");
    off.port.update();
    expect(off.estimates).toHaveLength(0);
  });

  it("goes quiet once the director unsubscribes", () => {
    const depth = fakeDepth();
    const { port, reports, stop } = setup({ depth, lighting: fakeLighting() });
    port.applyOcclusion({ mode: "soft", scope: "all" });
    stop();
    depth.texture = {};
    const before = reports.length;
    port.update();
    expect(reports).toHaveLength(before);
  });
});

describe("estimatedFromLighting", () => {
  it("turns a manager reading into the specs the director already speaks", () => {
    expect(estimatedFromLighting({})).toEqual({});

    const measured = estimatedFromLighting({
      ambientLight: { x: 1, y: 0.5, z: 0.25 },
      dirLight: { color: { r: 1, g: 1, b: 1 }, intensity: 3, position: { x: 0, y: 10, z: -5 } },
    });
    expect(measured.ambient?.colour).toEqual([1, 0.5, 0.25]);
    expect(measured.ambient?.intensity).toBeCloseTo(0.886227, 5);
    expect(measured.key?.direction).toEqual([-0, -10, 5]);
  });
});
