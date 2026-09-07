/**
 * The inbound half of the director: occlusion, light estimation, blend mode
 * and the reports that make all three visible when they do nothing.
 *
 * The assertions worth reading twice are the ones about ABSENCE. A port with
 * no depth, a session that never granted it, and an estimate that arrives
 * while estimation is off all produce a scene that looks entirely normal, so
 * "nothing happened, and here is why" is the only observable behaviour there
 * is.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  AmbientLightSpec,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
} from "@realitycollective/webxr-environment";
import {
  DEFAULT_LIGHT_ESTIMATION,
  DEFAULT_OCCLUSION,
  EnvironmentDirector,
  resolveLightEstimation,
  SENSING_FEATURES,
  unsupported,
} from "@realitycollective/webxr-environment";
import { RecordingEnvironmentPort, SensingEnvironmentPort } from "./helpers.js";

const AMBIENT: AmbientLightSpec = { colour: [1, 1, 1], intensity: 1 };
const KEY: KeyLightSpec = { colour: [1, 1, 1], intensity: 2, direction: [0, -1, 0] };
const IBL: IblSpec = { kind: "room" };
const MEASURED_AMBIENT: AmbientLightSpec = { colour: [0.2, 0.3, 0.4], intensity: 0.5 };
const MEASURED_KEY: KeyLightSpec = { colour: [1, 0.9, 0.8], intensity: 3, direction: [0, -1, 0] };
const MEASURED_IBL: IblSpec = { kind: "texture", src: "measured.hdr" };

function sensing(options: ConstructorParameters<typeof EnvironmentDirector>[1] = {}) {
  const port = new SensingEnvironmentPort();
  const director = new EnvironmentDirector(port, options);
  return { port, director };
}

describe("the ibl slot", () => {
  it("is flushed with the other four and pushed only when it moves", () => {
    const port = new RecordingEnvironmentPort();
    const director = new EnvironmentDirector(port, { initial: { ibl: IBL } });
    expect(port.last("ibl")).toEqual(IBL);

    port.clear();
    director.apply({ ibl: { kind: "room" } });
    expect(port.forSlot("ibl")).toHaveLength(0);

    director.apply({ ibl: null });
    expect(port.forSlot("ibl")).toEqual([{ slot: "ibl", value: null }]);
  });
});

describe("occlusion", () => {
  it("reaches the port only while passthrough is on, and is remembered", () => {
    const { port, director } = sensing();
    director.setOcclusion(DEFAULT_OCCLUSION);
    expect(port.occlusions).toEqual([]);
    expect(director.occlusion).toEqual(DEFAULT_OCCLUSION);

    director.setPassthrough(true);
    expect(port.occlusions).toEqual([DEFAULT_OCCLUSION]);

    director.setPassthrough(false);
    expect(port.occlusions).toEqual([DEFAULT_OCCLUSION, null]);

    director.setPassthrough(true);
    expect(port.occlusions).toEqual([DEFAULT_OCCLUSION, null, DEFAULT_OCCLUSION]);
  });

  it("does not re-apply a spec that is structurally the same", () => {
    const { port, director } = sensing({ passthrough: true });
    director.setOcclusion(DEFAULT_OCCLUSION);
    director.setOcclusion({ mode: "soft", scope: "all", source: { usage: "gpu-optimized" } });
    expect(port.occlusions).toHaveLength(1);
  });

  it("clears with null, and clearing twice pushes once", () => {
    const { port, director } = sensing({ passthrough: true });
    director.setOcclusion(DEFAULT_OCCLUSION);
    director.setOcclusion(null);
    director.setOcclusion(null);
    expect(port.occlusions).toEqual([DEFAULT_OCCLUSION, null]);
    expect(director.occlusion).toBeNull();
  });

  it("carries every knob the hosts expose", () => {
    const full: OcclusionSpec = {
      mode: "minmax-soft",
      scope: "tagged",
      softness: 0.25,
      source: {
        usage: "cpu-optimized",
        format: "unsigned-short",
        depthType: "smooth",
        matchDepthView: false,
      },
      updateFps: 15,
    };
    const { port, director } = sensing({ passthrough: true });
    director.setOcclusion(full);
    expect(port.occlusions[0]).toEqual(full);
  });

  it("reports unsupported instead of failing on a port with no depth", () => {
    const port = new RecordingEnvironmentPort();
    const director = new EnvironmentDirector(port, { passthrough: true });
    const seen = vi.fn();
    director.onSensing(seen);

    director.setOcclusion(DEFAULT_OCCLUSION);

    expect(director.getSensing("occlusion")).toEqual({
      feature: "occlusion",
      state: "unsupported",
      detail: "this adapter has no depth occlusion",
    });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("hides the sky while it is ACTIVE, because the renderer may already have", () => {
    // Passthrough suppresses nothing here, so the only thing that can take the
    // sky away is the occlusion report - which is the case three.js creates.
    const { port, director } = sensing({
      passthrough: true,
      passthroughSuppresses: [],
      initial: { sky: { kind: "solid", colour: [1, 0, 0] } },
    });
    expect(director.applied.sky).toEqual({ kind: "solid", colour: [1, 0, 0] });

    port.host?.report({ feature: "occlusion", state: "active" });
    expect(director.applied.sky).toBeNull();
    expect(director.current.sky).toEqual({ kind: "solid", colour: [1, 0, 0] });

    port.host?.report({ feature: "occlusion", state: "unavailable", detail: "session ended" });
    expect(director.applied.sky).toEqual({ kind: "solid", colour: [1, 0, 0] });
  });

  it("leaves the sky alone when the app says occlusion suppresses nothing", () => {
    const { port, director } = sensing({
      passthrough: true,
      passthroughSuppresses: [],
      occlusionSuppresses: [],
      initial: { sky: { kind: "solid", colour: [1, 0, 0] } },
    });
    port.host?.report({ feature: "occlusion", state: "active" });
    expect(director.applied.sky).toEqual({ kind: "solid", colour: [1, 0, 0] });
  });
});

describe("light estimation", () => {
  it("hands the port every default resolved", () => {
    const { port, director } = sensing();
    director.setLightEstimation(true);
    expect(port.estimations).toEqual([resolveLightEstimation(DEFAULT_LIGHT_ESTIMATION)]);
    expect(director.lightEstimation).toEqual({
      ambient: true,
      key: true,
      ibl: true,
      shadows: false,
    });
  });

  it("lays a measurement over the slots it was given and hands them back", () => {
    const { port, director } = sensing({ initial: { ambient: AMBIENT, key: KEY, ibl: IBL } });
    director.setLightEstimation({ ambient: true, key: true, ibl: false });

    port.host?.estimate({ ambient: MEASURED_AMBIENT, key: MEASURED_KEY, ibl: MEASURED_IBL });
    expect(director.applied.ambient).toEqual(MEASURED_AMBIENT);
    expect(director.applied.key).toEqual(MEASURED_KEY);
    // `ibl` was not opted in, so the app's own environment map stands.
    expect(director.applied.ibl).toEqual(IBL);
    // The request is untouched: an estimate is a layer, not an edit.
    expect(director.current.ambient).toEqual(AMBIENT);

    director.setLightEstimation(false);
    expect(port.estimations.at(-1)).toBeNull();
    expect(director.applied.ambient).toEqual(AMBIENT);
    expect(director.estimatedLighting).toBeNull();
  });

  it("leaves a slot alone when it was not opted in", () => {
    const { port, director } = sensing({ initial: { ambient: AMBIENT, ibl: IBL } });
    director.setLightEstimation({ ambient: false, ibl: true });
    port.host?.estimate({ ambient: MEASURED_AMBIENT, ibl: MEASURED_IBL });
    expect(director.applied.ambient).toEqual(AMBIENT);
    expect(director.applied.ibl).toEqual(MEASURED_IBL);
  });

  it("applies only what the host actually measured", () => {
    const { port, director } = sensing({ initial: { ambient: AMBIENT, key: KEY } });
    director.setLightEstimation(true);
    port.host?.estimate({ ambient: MEASURED_AMBIENT });
    expect(director.applied.ambient).toEqual(MEASURED_AMBIENT);
    expect(director.applied.key).toEqual(KEY);
  });

  it("treats a measured null as a measurement, not as a gap", () => {
    const { port, director } = sensing({ initial: { ambient: AMBIENT } });
    director.setLightEstimation(true);
    port.host?.estimate({ ambient: null });
    expect(director.applied.ambient).toBeNull();
  });

  it("ignores an estimate that arrives while estimation is off", () => {
    const { port, director } = sensing({ initial: { ambient: AMBIENT } });
    port.host?.estimate({ ambient: MEASURED_AMBIENT });
    expect(director.applied.ambient).toEqual(AMBIENT);
    expect(director.estimatedLighting).toBeNull();
  });

  it("does not re-tell the port the same thing", () => {
    const { port, director } = sensing();
    director.setLightEstimation(true);
    director.setLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(port.estimations).toHaveLength(1);
  });

  it("takes null and false as the same instruction", () => {
    const { port, director } = sensing();
    director.setLightEstimation(true);
    director.setLightEstimation(null);
    expect(port.estimations).toEqual([resolveLightEstimation({}), null]);
  });

  it("reports unsupported on a port that cannot estimate", () => {
    const port = new RecordingEnvironmentPort();
    const director = new EnvironmentDirector(port);
    director.setLightEstimation(true);
    expect(director.getSensing("lightEstimation")).toEqual({
      feature: "lightEstimation",
      state: "unsupported",
      detail: "this adapter has no light estimation",
    });
  });
});

describe("sensing reports", () => {
  it("default to unsupported for every feature", () => {
    const { director } = sensing();
    for (const feature of SENSING_FEATURES) {
      expect(director.getSensing(feature)).toEqual({ feature, state: "unsupported" });
    }
  });

  it("fire once per change and never for a repeat", () => {
    const { port, director } = sensing();
    const seen = vi.fn();
    const stop = director.onSensing(seen);

    port.host?.report({ feature: "depthTexture", state: "pending" });
    port.host?.report({ feature: "depthTexture", state: "pending" });
    expect(seen).toHaveBeenCalledTimes(1);

    port.host?.report({ feature: "depthTexture", state: "active" });
    expect(seen).toHaveBeenCalledTimes(2);

    stop();
    port.host?.report({ feature: "depthTexture", state: "unavailable" });
    expect(seen).toHaveBeenCalledTimes(2);
    expect(director.getSensing("depthTexture").state).toBe("unavailable");
  });

  it("carry a detail for a human and nothing to switch on", () => {
    expect(unsupported("occlusion")).toEqual({ feature: "occlusion", state: "unsupported" });
    expect(unsupported("occlusion", "no depth here")).toEqual({
      feature: "occlusion",
      state: "unsupported",
      detail: "no depth here",
    });
  });

  it("stop at dispose, along with the port's subscription", () => {
    const { port, director } = sensing();
    director.setLightEstimation(true);
    director.dispose();

    expect(port.unobserved).toBe(true);
    port.host?.report({ feature: "occlusion", state: "active" });
    port.host?.estimate({ ambient: MEASURED_AMBIENT });
    expect(director.getSensing("occlusion").state).toBe("unsupported");
    expect(director.estimatedLighting).toBeNull();
  });

  it("survive a port that returns no teardown", () => {
    const port = new SensingEnvironmentPort();
    port.returnUnobserve = false;
    const director = new EnvironmentDirector(port);
    expect(() => {
      director.dispose();
    }).not.toThrow();
    expect(port.unobserved).toBe(false);
  });
});

describe("a polling port", () => {
  it("is ticked on every update, with or without a transition", () => {
    const { port, director } = sensing();
    director.update(16);
    director.transition({ ambient: AMBIENT }, { durationMs: 100 });
    director.update(16);
    expect(port.ticks).toEqual([16, 16]);

    director.dispose();
    director.update(16);
    expect(port.ticks).toEqual([16, 16]);
  });
});

describe("blend mode", () => {
  it("counts anything but opaque as passthrough, and remembers which", () => {
    const { director } = sensing();
    director.setPassthrough("additive");
    expect(director.passthrough).toBe(true);
    expect(director.blendMode).toBe("additive");

    director.setPassthrough("opaque");
    expect(director.passthrough).toBe(false);
    expect(director.blendMode).toBe("opaque");
  });

  it("keeps the mode when told only a boolean", () => {
    const { director } = sensing();
    director.setPassthrough("alpha-blend");
    director.setPassthrough(false);
    expect(director.passthrough).toBe(false);
    expect(director.blendMode).toBe("alpha-blend");
    director.setPassthrough(false);
    expect(director.blendMode).toBe("alpha-blend");
  });

  it("starts in a mode when constructed with one", () => {
    const { director } = sensing({ passthrough: "alpha-blend" });
    expect(director.passthrough).toBe(true);
    expect(director.blendMode).toBe("alpha-blend");
  });

  it("suppresses different slots per mode when the app asks it to", () => {
    const initial = {
      sky: { kind: "solid", colour: [1, 0, 0] } as const,
      fog: { kind: "exponential", colour: [0, 0, 0], density: 0.1 } as const,
    };
    const { director } = sensing({
      initial,
      passthroughSuppresses: {
        // A dark fog is invisible on an additive display, so it goes; on
        // alpha-blend it stays and does its job.
        "alpha-blend": ["sky"],
        additive: ["sky", "fog"],
      },
    });

    director.setPassthrough("alpha-blend");
    expect(director.applied.sky).toBeNull();
    expect(director.applied.fog).toEqual(initial.fog);

    director.setPassthrough("additive");
    expect(director.applied.fog).toBeNull();
  });

  it("can hide the light slots too, for a host that lights the scene itself", () => {
    const { director } = sensing({
      initial: { ambient: AMBIENT, key: KEY, ibl: IBL },
      passthrough: true,
      passthroughSuppresses: ["ambient", "ibl"],
    });
    expect(director.applied.ambient).toBeNull();
    expect(director.applied.ibl).toBeNull();
    expect(director.applied.key).toEqual(KEY);
  });

  it("falls back to the default list for a mode the app did not describe", () => {
    const { director } = sensing({
      initial: { sky: { kind: "solid", colour: [1, 0, 0] } },
      passthroughSuppresses: { additive: [] },
    });
    director.setPassthrough("alpha-blend");
    expect(director.applied.sky).toBeNull();
  });

  it("falls back to the default list when passthrough is on with no mode", () => {
    const { director } = sensing({
      initial: { sky: { kind: "solid", colour: [1, 0, 0] } },
      passthroughSuppresses: { additive: [] },
      passthrough: true,
    });
    expect(director.applied.sky).toBeNull();
  });
});
