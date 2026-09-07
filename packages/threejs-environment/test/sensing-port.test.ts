/**
 * The three.js port's sensor-backed half: image-based lighting, authored
 * skies, depth occlusion and light estimation.
 *
 * There is no GPU here and no headset. Depth occlusion on three.js is entirely
 * the renderer's work once the session grants it, so what this port actually
 * decides is whether the request CAN be served - and that decision is made
 * from a session object, which an object literal can be. Light estimation is
 * the same story with an XRFrame.
 */
import { describe, expect, it, vi } from "vitest";
import { DataTexture, Scene, Texture } from "three";
import type {
  EnvironmentPortHost,
  EstimatedLighting,
  IblSpec,
  SensingReport,
} from "@realitycollective/threejs-environment";
import {
  ambientFromSphericalHarmonics,
  gradientColourAt,
  keyFromEstimate,
  ThreeEnvironmentPort,
  toEstimatedLighting,
} from "@realitycollective/threejs-environment";
import type {
  XrFrameLike,
  XrLightProbeLike,
  XrRendererLike,
  XrSessionLike,
} from "@realitycollective/threejs-environment";

/** Collects everything the port says, the way the director would. */
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

interface FakeRenderer extends XrRendererLike {
  depthSensing: boolean;
  frame: XrFrameLike | null;
  session: XrSessionLike | null;
}

function fakeRenderer(session: XrSessionLike | null): FakeRenderer {
  const renderer: FakeRenderer = {
    depthSensing: false,
    frame: null,
    session,
    xr: {
      getSession: () => renderer.session,
      getFrame: () => renderer.frame,
      hasDepthSensing: () => renderer.depthSensing,
    },
  };
  return renderer;
}

const DEPTH_SESSION: XrSessionLike = {
  enabledFeatures: ["depth-sensing"],
  depthUsage: "gpu-optimized",
};

function setup(session: XrSessionLike | null = DEPTH_SESSION) {
  const scene = new Scene();
  const renderer = fakeRenderer(session);
  const port = new ThreeEnvironmentPort(scene, { renderer });
  const { host, reports, estimates } = recordingHost();
  const stop = port.observe(host);
  return { scene, renderer, port, reports, estimates, stop };
}

describe("image-based lighting", () => {
  it("hangs a generated ramp on the scene and moves its numbers", () => {
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene);

    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0], intensity: 2 });
    const texture = scene.environment;
    expect(texture).toBeInstanceOf(DataTexture);
    expect(scene.environmentIntensity).toBe(2);

    // A transition pushes a new value every frame, so the texture is updated
    // in place rather than reallocated.
    port.applyIbl({ kind: "gradient", top: [0, 0, 0], bottom: [1, 1, 1], rotationY: 1 });
    expect(scene.environment).toBe(texture);
    expect(scene.environmentRotation.y).toBe(1);

    port.applyIbl(null);
    expect(scene.environment).toBeNull();
    expect(scene.environmentIntensity).toBe(1);
  });

  it("loads an image and swaps it in, ignoring a load that lost the race", async () => {
    const first = new Texture();
    const second = new Texture();
    const disposeFirst = vi.spyOn(first, "dispose");
    let resolveFirst: (texture: Texture) => void = () => {};
    const loadAsync = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<Texture>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(async () => second);

    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, { textureLoader: { loadAsync } });

    port.applyIbl({ kind: "texture", src: "one.hdr" });
    port.applyIbl({ kind: "texture", src: "two.hdr" });
    resolveFirst(first);
    await vi.waitFor(() => expect(scene.environment).toBe(second));
    expect(disposeFirst).toHaveBeenCalled();
  });

  it("drops a sky image that arrives after the app moved on", async () => {
    const late = new Texture();
    const dispose = vi.spyOn(late, "dispose");
    let resolveLate: (texture: Texture) => void = () => {};
    const loadAsync = vi
      .fn()
      .mockImplementationOnce(
        async () =>
          new Promise<Texture>((resolve) => {
            resolveLate = resolve;
          }),
      )
      .mockImplementationOnce(async () => new Texture());
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, { textureLoader: { loadAsync } });

    // No intensity, rotation or blur here: the documented defaults are a
    // branch of their own, and this is the sky most apps actually write.
    port.applySky({ kind: "texture", src: "one.hdr" });
    expect(scene.backgroundIntensity).toBe(1);
    expect(scene.backgroundBlurriness).toBe(0);
    port.applySky({ kind: "texture", src: "two.hdr" });
    resolveLate(late);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalled());
  });

  it("releases what it owns even when the app took the slot away", async () => {
    const image = new Texture();
    const disposeImage = vi.spyOn(image, "dispose");
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, {
      textureLoader: { loadAsync: async () => image },
    });

    port.applySky({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    // An app that writes the scene behind the port is misusing it, but the
    // port still owns those textures and still has to let them go.
    scene.background = null;
    scene.environment = null;
    port.applySky(null);
    port.applyIbl(null);

    port.applyIbl({ kind: "texture", src: "one.hdr" });
    await vi.waitFor(() => expect(scene.environment).toBe(image));
    scene.environment = null;
    port.applyIbl(null);
    expect(disposeImage).toHaveBeenCalled();
  });

  it("keeps the slot as it was when the image will not load", async () => {
    const loadAsync = vi.fn().mockRejectedValue(new Error("404"));
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, { textureLoader: { loadAsync } });
    port.applyIbl({ kind: "texture", src: "missing.hdr" });
    await vi.waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(scene.environment).toBeNull();
  });

  it("prefilters a room probe when it can, and approximates one when it cannot", () => {
    const prefiltered = new Texture();
    const prefilter = vi.fn(() => prefiltered);
    const withRenderer = new Scene();
    new ThreeEnvironmentPort(withRenderer, { prefilter }).applyIbl({ kind: "room" });
    expect(prefilter).toHaveBeenCalledTimes(1);
    expect(withRenderer.environment).toBe(prefiltered);

    const without = new Scene();
    new ThreeEnvironmentPort(without).applyIbl({ kind: "room", intensity: 0.5 });
    expect(without.environment).toBeInstanceOf(DataTexture);
    expect(without.environmentIntensity).toBe(0.5);
  });

  it("releases a loaded image when a gradient replaces it", async () => {
    const loaded = new Texture();
    const dispose = vi.spyOn(loaded, "dispose");
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, {
      textureLoader: { loadAsync: async () => loaded },
    });
    port.applyIbl({ kind: "texture", src: "one.hdr" });
    await vi.waitFor(() => expect(scene.environment).toBe(loaded));

    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    expect(dispose).toHaveBeenCalled();
    expect(scene.environment).toBeInstanceOf(DataTexture);
  });
});

describe("an authored sky", () => {
  it("carries intensity, rotation and blur, and is released on the next sky", async () => {
    const image = new Texture();
    const dispose = vi.spyOn(image, "dispose");
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, {
      textureLoader: { loadAsync: async () => image },
    });

    port.applySky({ kind: "texture", src: "sky.hdr", intensity: 2, rotationY: 1, blur: 0.5 });
    await vi.waitFor(() => expect(scene.background).toBe(image));
    expect(scene.backgroundIntensity).toBe(2);
    expect(scene.backgroundRotation.y).toBe(1);
    expect(scene.backgroundBlurriness).toBe(0.5);

    port.applySky({ kind: "solid", colour: [1, 0, 0] });
    expect(dispose).toHaveBeenCalled();
    expect(scene.backgroundBlurriness).toBe(0);

    port.applySky(null);
    expect(scene.background).toBeNull();
    expect(scene.backgroundIntensity).toBe(1);
  });

  it("leaves the sky empty when the image will not load", async () => {
    const loadAsync = vi.fn().mockRejectedValue(new Error("404"));
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, { textureLoader: { loadAsync } });
    port.applySky({ kind: "texture", src: "missing.hdr" });
    await vi.waitFor(() => expect(loadAsync).toHaveBeenCalled());
    expect(scene.background).toBeNull();
  });

  it("takes a gradient's intensity from the scene, not from the pixels", () => {
    const scene = new Scene();
    new ThreeEnvironmentPort(scene).applySky({
      kind: "gradient",
      top: [1, 1, 1],
      bottom: [0, 0, 0],
      intensity: 3,
    });
    expect(scene.backgroundIntensity).toBe(3);
  });

  it("puts a horizon stop where the app asked for one", () => {
    const gradient = {
      kind: "gradient",
      top: [1, 1, 1],
      bottom: [0, 0, 0],
      equator: [1, 0, 0],
    } as const;
    expect(gradientColourAt(gradient, 0.5)).toEqual([1, 0, 0]);
    expect(gradientColourAt(gradient, 0.25)).toEqual([0.5, 0, 0]);
    expect(gradientColourAt(gradient, 0.75)).toEqual([1, 0.5, 0.5]);
    // A horizon at the nadir leaves only the upper half of the ramp.
    expect(gradientColourAt({ ...gradient, horizon: 0 }, 0)).toEqual([1, 0, 0]);
    // The exponent shapes each half, so a squared ramp darkens the middle.
    expect(gradientColourAt({ ...gradient, exponent: 2 }, 0.25)).toEqual([0.25, 0, 0]);
  });
});

describe("depth occlusion", () => {
  it("goes pending, then active when the depth texture arrives, and back", () => {
    const { renderer, port, reports } = setup();
    port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(reports.at(-1)).toEqual({
      feature: "occlusion",
      state: "pending",
      detail: "waiting for the first depth frame",
    });

    // A tick with no depth yet says nothing new: pending is still the truth.
    port.update();
    expect(reports).toHaveLength(1);

    renderer.depthSensing = true;
    port.update();
    expect(reports.at(-2)).toEqual({ feature: "occlusion", state: "active" });
    expect(reports.at(-1)).toEqual({ feature: "depthTexture", state: "active" });

    renderer.depthSensing = false;
    port.update();
    expect(reports.at(-2)).toEqual({
      feature: "occlusion",
      state: "pending",
      detail: "the depth texture went away",
    });
    expect(reports.at(-1)).toEqual({ feature: "depthTexture", state: "unavailable" });
  });

  it("says why it cannot, for every way it cannot", () => {
    const scene = new Scene();
    const bare = new ThreeEnvironmentPort(scene);
    const { host, reports } = recordingHost();
    bare.observe(host);
    bare.applyOcclusion({ mode: "soft", scope: "all" });
    expect(reports.at(-1)?.state).toBe("unsupported");
    expect(reports.at(-1)?.detail).toContain("without a renderer");

    const noSession = setup(null);
    noSession.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(noSession.reports.at(-1)?.detail).toContain("no XR session");

    const noFeature = setup({ enabledFeatures: [] });
    noFeature.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(noFeature.reports.at(-1)?.detail).toContain("did not enable depth-sensing");

    const cpu = setup({ enabledFeatures: ["depth-sensing"], depthUsage: "cpu-optimized" });
    cpu.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(cpu.reports.at(-1)?.detail).toContain("cpu-optimized");

    const noUsage = setup({ enabledFeatures: ["depth-sensing"] });
    noUsage.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(noUsage.reports.at(-1)?.detail).toContain("none");

    const tagged = setup();
    tagged.port.applyOcclusion({ mode: "soft", scope: "tagged" });
    expect(tagged.reports.at(-1)?.detail).toContain("tagged");
    // A refused request is not polled for.
    tagged.renderer.depthSensing = true;
    tagged.port.update();
    expect(tagged.reports.at(-1)?.detail).toContain("tagged");
  });

  it("says so when it is turned off, and then stops polling", () => {
    const { renderer, port, reports } = setup();
    port.applyOcclusion({ mode: "soft", scope: "all" });
    port.applyOcclusion(null);
    expect(reports.at(-1)).toEqual({
      feature: "occlusion",
      state: "unavailable",
      detail: "occlusion is off",
    });
    renderer.depthSensing = true;
    port.update();
    expect(reports.at(-1)?.detail).toBe("occlusion is off");
  });
});

describe("light estimation", () => {
  const PROBE: XrLightProbeLike = {};
  const ESTIMATE = {
    sphericalHarmonicsCoefficients: [1, 0.5, 0.25],
    primaryLightDirection: { x: 0, y: 1, z: 0 },
    primaryLightIntensity: { x: 4, y: 2, z: 1 },
  };

  function estimating(session: Partial<XrSessionLike> = {}) {
    return setup({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () => PROBE,
      ...session,
    });
  }

  it("requests a probe, then reports each reading and hands over the lighting", async () => {
    const { renderer, port, reports, estimates } = estimating({
      preferredReflectionFormat: "srgba8",
    });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    await vi.waitFor(() =>
      expect(reports.at(-1)).toEqual({
        feature: "lightEstimation",
        state: "pending",
        detail: "waiting for the first estimate",
      }),
    );

    renderer.frame = { getLightEstimate: () => ESTIMATE };
    port.update();
    // No `reflection` option, so ambient and key are measured and the
    // reflections are not - and it says which.
    expect(reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "active",
      detail:
        "ambient and key are measured; the reflections are not, because no reflection option was given",
    });
    expect(estimates.at(-1)?.ambient?.intensity).toBeCloseTo(0.886227, 5);
    expect(estimates.at(-1)?.key?.direction).toEqual([-0, -1, -0]);

    // A second reading updates the estimate without re-announcing.
    port.update();
    expect(estimates).toHaveLength(2);
    expect(reports.filter((r) => r.feature === "lightEstimation")).toHaveLength(2);
  });

  it("delivers the measured reflections when the app can reach them", async () => {
    const first = new Texture();
    const second = new Texture();
    let current = first;
    const scene = new Scene();
    const renderer = fakeRenderer({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () => PROBE,
    });
    const port = new ThreeEnvironmentPort(scene, {
      renderer,
      reflection: () => current,
    });
    const { host, reports, estimates } = recordingHost();
    port.observe(host);

    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("pending"));
    renderer.frame = { getLightEstimate: () => ESTIMATE };
    port.update();

    // The estimate now carries the marker, which the director puts in the ibl
    // slot and hands straight back to the port.
    expect(estimates.at(-1)?.ibl).toEqual({ kind: "estimated" });
    port.applyIbl({ kind: "estimated", intensity: 2 });
    expect(scene.environment).toBe(first);
    expect(scene.environmentIntensity).toBe(2);

    // The runtime replaces the texture as the room changes; the slot follows
    // without the spec changing at all.
    current = second;
    port.update();
    expect(scene.environment).toBe(second);
  });

  it("waits, visibly, when the estimated map is asked for before there is one", () => {
    const scene = new Scene();
    const port = new ThreeEnvironmentPort(scene, { renderer: fakeRenderer(DEPTH_SESSION) });
    const { host, reports } = recordingHost();
    port.observe(host);

    port.applyIbl({ kind: "estimated" });
    expect(scene.environment).toBeNull();
    expect(reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "pending",
      detail: "waiting for a reflection cube map to use as the environment map",
    });
  });

  it("leaves the measured map alone when the slot moves on", async () => {
    const measured = new Texture();
    const scene = new Scene();
    const renderer = fakeRenderer({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () => PROBE,
    });
    const port = new ThreeEnvironmentPort(scene, { renderer, reflection: () => measured });
    const { host, reports } = recordingHost();
    port.observe(host);
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("pending"));
    renderer.frame = { getLightEstimate: () => ESTIMATE };
    port.update();
    port.applyIbl({ kind: "estimated" });
    expect(scene.environment).toBe(measured);

    // Switching the slot to something of our own must not dispose a texture
    // the APP built and still owns.
    const dispose = vi.spyOn(measured, "dispose");
    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    expect(dispose).not.toHaveBeenCalled();
    port.dispose();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("stamps the shadow flag the app asked for onto the measured key light", async () => {
    const { renderer, port, estimates } = estimating();
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: true });
    await vi.waitFor(() => expect(renderer.session).not.toBeNull());
    renderer.frame = { getLightEstimate: () => ESTIMATE };
    port.update();
    await vi.waitFor(() => expect(estimates.at(-1)?.key?.castShadow).toBe(true));
  });

  it("does nothing until there is a frame with an estimate in it", async () => {
    const { renderer, port, estimates, reports } = estimating();
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    await vi.waitFor(() => expect(reports.at(-1)?.state).toBe("pending"));

    // No frame at all, a frame that cannot estimate, and a frame that has
    // nothing to report are three different runtimes and one outcome.
    port.update();
    renderer.frame = {};
    port.update();
    renderer.frame = { getLightEstimate: () => null };
    port.update();
    expect(estimates).toHaveLength(0);
  });

  it("reads a session that lists no features at all", () => {
    const bare = setup({});
    bare.port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(bare.reports.at(-1)?.detail).toContain("did not enable depth-sensing");

    const probe = setup({ requestLightProbe: async () => PROBE });
    probe.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(probe.reports.at(-1)?.detail).toContain("did not enable light-estimation");
  });

  it("says why it cannot, for every way it cannot", async () => {
    const scene = new Scene();
    const bare = new ThreeEnvironmentPort(scene);
    const { host, reports } = recordingHost();
    bare.observe(host);
    bare.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(reports.at(-1)?.detail).toContain("without a renderer");

    const noSession = setup(null);
    noSession.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(noSession.reports.at(-1)?.detail).toContain("no XR session");

    const noProbe = setup({ enabledFeatures: ["light-estimation"] });
    noProbe.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(noProbe.reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "unsupported",
      detail: "this runtime has no light probe",
    });

    const noFeature = setup({ enabledFeatures: [], requestLightProbe: async () => PROBE });
    noFeature.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(noFeature.reports.at(-1)?.detail).toContain("did not enable light-estimation");

    const refused = setup({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () => {
        throw new Error("no");
      },
    });
    refused.port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    await vi.waitFor(() => expect(refused.reports.at(-1)?.detail).toContain("refused a light probe"));
  });

  it("drops a probe that arrives after the app changed its mind", async () => {
    let resolveProbe: (probe: XrLightProbeLike) => void = () => {};
    const { port, reports } = setup({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () =>
        new Promise<XrLightProbeLike>((resolve) => {
          resolveProbe = resolve;
        }),
    });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    port.applyLightEstimation(null);
    resolveProbe(PROBE);
    await Promise.resolve();
    expect(reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "unavailable",
      detail: "light estimation is off",
    });
  });

  it("drops a REFUSAL that arrives after the app changed its mind", async () => {
    let rejectProbe: (error: unknown) => void = () => {};
    const { port, reports } = setup({
      enabledFeatures: ["light-estimation"],
      requestLightProbe: async () =>
        new Promise<XrLightProbeLike>((_resolve, reject) => {
          rejectProbe = reject;
        }),
    });
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    port.applyLightEstimation(null);
    rejectProbe(new Error("too late"));
    await Promise.resolve();
    expect(reports.at(-1)?.detail).toBe("light estimation is off");
  });

  it("goes quiet once the director unsubscribes", () => {
    const { renderer, port, reports, stop } = setup();
    port.applyOcclusion({ mode: "soft", scope: "all" });
    stop();
    renderer.depthSensing = true;
    const before = reports.length;
    port.update();
    expect(reports).toHaveLength(before);
  });
});

describe("the estimate conversions", () => {
  it("read the ambient term out of the first band only", () => {
    expect(ambientFromSphericalHarmonics(undefined)).toBeNull();
    expect(ambientFromSphericalHarmonics([1, 2])).toBeNull();
    expect(ambientFromSphericalHarmonics([0, 0, 0])).toEqual({ colour: [0, 0, 0], intensity: 0 });
    // A runtime that reports a length it cannot fill reads as darkness, not
    // as NaN. `noUncheckedIndexedAccess` makes that an explicit branch.
    expect(ambientFromSphericalHarmonics({ length: 3 } as unknown as ArrayLike<number>)).toEqual({
      colour: [0, 0, 0],
      intensity: 0,
    });

    const ambient = ambientFromSphericalHarmonics([1, 0.5, 0.25, 9, 9, 9]);
    expect(ambient?.colour).toEqual([1, 0.5, 0.25]);
    expect(ambient?.intensity).toBeCloseTo(0.886227, 5);
  });

  it("turn the primary light around, because a key light travels", () => {
    expect(keyFromEstimate({})).toBeNull();
    expect(keyFromEstimate({ primaryLightDirection: { x: 0, y: 1, z: 0 } })).toBeNull();

    const key = keyFromEstimate({
      primaryLightDirection: { x: 0, y: 1, z: 0 },
      primaryLightIntensity: { x: 4, y: 2, z: 1 },
    });
    expect(key).toEqual({ colour: [1, 0.5, 0.25], intensity: 4, direction: [-0, -1, -0] });

    // A dim room keeps unity as the scalar, so the colour stays a colour.
    const dim = keyFromEstimate({
      primaryLightDirection: { x: 1, y: 0, z: 0 },
      primaryLightIntensity: { x: 0.5, y: 0.5, z: 0.5 },
    });
    expect(dim?.intensity).toBe(1);
  });

  it("omit what was not measured", () => {
    expect(toEstimatedLighting({})).toEqual({});
    const ibl: IblSpec | undefined = toEstimatedLighting({
      sphericalHarmonicsCoefficients: [1, 1, 1],
    }).ibl as IblSpec | undefined;
    // The reflection cube map needs a GL binding, so it is never part of an
    // estimate this port produces.
    expect(ibl).toBeUndefined();
  });
});
