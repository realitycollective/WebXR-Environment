/**
 * The IWSDK port's newer half: image-based lighting, authored domes, depth
 * occlusion and the light estimation this host does not have.
 *
 * As with the rest of this package's tests, the COMPONENTS are real. Only the
 * world and its entities are faked, so a misspelled field name fails here
 * rather than on a headset.
 */
import { describe, expect, it } from "vitest";
import {
  DepthOccludable,
  DepthSensingSystem,
  DomeGradient,
  DomeTexture,
  IBLGradient,
  IBLTexture,
  OcclusionShadersMode,
} from "@iwsdk/core";
import type {
  EnvironmentPortHost,
  EstimatedLighting,
  SensingReport,
} from "@realitycollective/iwsdk-environment";
import { IWSDKEnvironmentPort } from "@realitycollective/iwsdk-environment";
import {
  asEntity,
  asWorld,
  createFakeEntity,
  createFakeWorld,
  type FakeWorld,
} from "./helpers.js";

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

function setup(options: ConstructorParameters<typeof IWSDKEnvironmentPort>[1] = {}) {
  const world = createFakeWorld();
  const port = new IWSDKEnvironmentPort(asWorld(world), options);
  const { host, reports, estimates } = recordingHost();
  const stop = port.observe(host);
  return { world, port, reports, estimates, stop };
}

function root(world: FakeWorld) {
  const level = world.activeLevel.value;
  if (level === null) throw new Error("no level");
  return level;
}

describe("image-based lighting", () => {
  it("writes IWSDK's three-stop IBL gradient", () => {
    const { world, port } = setup();
    port.applyIbl({ kind: "gradient", top: [0, 0, 1], bottom: [1, 0, 0], intensity: 2 });
    const level = root(world);
    expect(level.hasComponent(IBLGradient)).toBe(true);
    expect(Array.from(level.getVectorView(IBLGradient, "sky"))).toEqual([0, 0, 1, 1]);
    expect(Array.from(level.getVectorView(IBLGradient, "ground"))).toEqual([1, 0, 0, 1]);
    // No horizon stop given, so it comes from the ramp - the same colour the
    // three.js adapter puts there.
    expect(Array.from(level.getVectorView(IBLGradient, "equator"))).toEqual([0.5, 0, 0.5, 1]);
    expect(level.getValue(IBLGradient, "intensity")).toBe(2);
  });

  it("uses the horizon colour the app gave, on both the sky and the map", () => {
    const { world, port } = setup();
    port.applySky({ kind: "gradient", top: [0, 0, 1], bottom: [1, 0, 0], equator: [0, 1, 0] });
    port.applyIbl({ kind: "gradient", top: [0, 0, 1], bottom: [1, 0, 0], equator: [0, 1, 0] });
    const level = root(world);
    expect(Array.from(level.getVectorView(DomeGradient, "equator"))).toEqual([0, 1, 0, 1]);
    expect(Array.from(level.getVectorView(IBLGradient, "equator"))).toEqual([0, 1, 0, 1]);
  });

  it("takes room natively, because IWSDK has one", () => {
    const { world, port } = setup();
    port.applyIbl({ kind: "room", intensity: 0.5, rotationY: 1 });
    const level = root(world);
    expect(level.getValue(IBLTexture, "src")).toBe("room");
    expect(level.getValue(IBLTexture, "intensity")).toBe(0.5);
    expect(Array.from(level.getVectorView(IBLTexture, "rotation")).slice(0, 3)).toEqual([0, 1, 0]);
  });

  it("swaps between the two IBL components rather than stacking them", () => {
    const { world, port } = setup();
    const level = root(world);

    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    port.applyIbl({ kind: "texture", src: "room.hdr" });
    expect(level.hasComponent(IBLGradient)).toBe(false);
    expect(level.getValue(IBLTexture, "src")).toBe("room.hdr");

    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    expect(level.hasComponent(IBLTexture)).toBe(false);

    port.applyIbl(null);
    expect(level.hasComponent(IBLGradient)).toBe(false);
    port.applyIbl(null);
    expect(level.hasComponent(IBLTexture)).toBe(false);
  });

  it("keeps the component it already put there across a transition", () => {
    const { world, port } = setup();
    const level = root(world);

    // Every frame of a transition pushes a new value for the same kind. The
    // component is added once and written to after that.
    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    port.applyIbl({ kind: "gradient", top: [0, 0, 0], bottom: [1, 1, 1] });
    expect(Array.from(level.getVectorView(IBLGradient, "sky"))).toEqual([0, 0, 0, 1]);

    port.applyIbl({ kind: "texture", src: "one.hdr" });
    port.applyIbl({ kind: "texture", src: "two.hdr" });
    expect(level.getValue(IBLTexture, "src")).toBe("two.hdr");

    port.applySky({ kind: "texture", src: "one.hdr" });
    port.applySky({ kind: "texture", src: "two.hdr" });
    expect(level.getValue(DomeTexture, "src")).toBe("two.hdr");

    port.applySky({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0], exponent: 2 });
    port.applySky({ kind: "gradient", top: [0, 0, 0], bottom: [1, 1, 1], exponent: 2 });
    // With no horizon colour and a squared ramp, the middle sits a quarter of
    // the way up rather than halfway.
    expect(Array.from(level.getVectorView(DomeGradient, "equator"))).toEqual([0.75, 0.75, 0.75, 1]);
  });

  it("keeps the app's own map when asked for one it cannot measure", () => {
    const { world, port, reports } = setup();
    port.applyIbl({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    port.applyIbl({ kind: "estimated" });

    expect(reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "unsupported",
      detail: "IWSDK measures no reflections, so an estimated environment map cannot be applied",
    });
    // The gradient it had is still there: losing it as well would be a second
    // failure on top of the one being reported.
    expect(root(world).hasComponent(IBLGradient)).toBe(true);
  });

  it("does nothing at all without a level to hang it on", () => {
    const world = createFakeWorld({ withLevel: false });
    const port = new IWSDKEnvironmentPort(asWorld(world));
    expect(() => {
      port.applyIbl({ kind: "room" });
    }).not.toThrow();
  });
});

describe("an authored dome", () => {
  it("replaces the gradient dome and carries blur and rotation", () => {
    const { world, port } = setup();
    const level = root(world);
    port.applySky({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    port.applySky({ kind: "texture", src: "sky.hdr", intensity: 2, rotationY: 1, blur: 0.25 });

    expect(level.hasComponent(DomeGradient)).toBe(false);
    expect(level.getValue(DomeTexture, "src")).toBe("sky.hdr");
    expect(level.getValue(DomeTexture, "intensity")).toBe(2);
    expect(level.getValue(DomeTexture, "blurriness")).toBe(0.25);
    expect(Array.from(level.getVectorView(DomeTexture, "rotation")).slice(0, 3)).toEqual([0, 1, 0]);

    port.applySky({ kind: "solid", colour: [1, 0, 0] });
    expect(level.hasComponent(DomeTexture)).toBe(false);
    expect(level.hasComponent(DomeGradient)).toBe(true);
  });

  it("falls back to the port's own intensity", () => {
    const { world, port } = setup({ skyIntensity: 3 });
    port.applySky({ kind: "texture", src: "sky.hdr" });
    expect(root(world).getValue(DomeTexture, "intensity")).toBe(3);
    port.applySky({ kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] });
    expect(root(world).getValue(DomeGradient, "intensity")).toBe(3);
  });
});

describe("depth occlusion", () => {
  it("registers the depth system and opts the app's entities in", () => {
    const first = createFakeEntity();
    const second = createFakeEntity();
    const { world, port, reports } = setup({ occludables: () => [asEntity(first), asEntity(second)] });

    port.applyOcclusion({ mode: "hard", scope: "all", softness: 0.5 });

    expect(world.registeredSystems).toContain(DepthSensingSystem);
    const system = world.getSystem(DepthSensingSystem);
    expect(system?.config["enableOcclusion"]?.value).toBe(true);
    expect(system?.config["blurRadius"]?.value).toBe(20);
    expect(first.hasComponent(DepthOccludable)).toBe(true);
    expect(first.components.get(DepthOccludable)?.["mode"]).toBe(
      OcclusionShadersMode.HardOcclusion,
    );
    expect(reports.at(-1)).toEqual({
      feature: "occlusion",
      state: "active",
      detail: "occluding 2 entities",
    });

    port.applyOcclusion(null);
    expect(first.hasComponent(DepthOccludable)).toBe(false);
    expect(second.hasComponent(DepthOccludable)).toBe(false);
    expect(system?.config["enableOcclusion"]?.value).toBe(false);
    expect(reports.at(-1)?.detail).toBe("occlusion is off");
  });

  it("reconfigures a system that is already registered", () => {
    const entity = createFakeEntity();
    const { world, port } = setup({ occludables: () => [asEntity(entity)] });
    port.applyOcclusion({ mode: "soft", scope: "all" });
    port.applyOcclusion({
      mode: "minmax-soft",
      scope: "all",
      softness: 0.25,
      source: { format: "luminance-alpha" },
    });

    const system = world.getSystem(DepthSensingSystem);
    expect(world.registeredSystems.filter((s) => s === DepthSensingSystem)).toHaveLength(1);
    expect(system?.config["useFloat32"]?.value).toBe(false);
    expect(system?.config["blurRadius"]?.value).toBe(10);
    expect(entity.components.get(DepthOccludable)?.["mode"]).toBe(
      OcclusionShadersMode.MinMaxSoftOcclusion,
    );
  });

  it("leaves the softness alone when a later spec does not name one", () => {
    const entity = createFakeEntity();
    const { world, port } = setup({ occludables: () => [asEntity(entity)] });
    port.applyOcclusion({ mode: "soft", scope: "all", softness: 0.5 });
    port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(world.getSystem(DepthSensingSystem)?.config["blurRadius"]?.value).toBe(20);
  });

  it("does not trip over an opt-in the app removed behind its back", () => {
    const entity = createFakeEntity();
    const { port } = setup({ occludables: () => [asEntity(entity)] });
    port.applyOcclusion({ mode: "soft", scope: "all" });
    entity.removeComponent(DepthOccludable);
    expect(() => {
      port.applyOcclusion(null);
    }).not.toThrow();
  });

  it("never removes a component the app added itself", () => {
    const tagged = createFakeEntity();
    tagged.addComponent(DepthOccludable);
    const { port } = setup({ occludables: () => [asEntity(tagged)] });

    port.applyOcclusion({ mode: "soft", scope: "all" });
    port.applyOcclusion(null);
    expect(tagged.hasComponent(DepthOccludable)).toBe(true);
  });

  it("configures the system and stands back when the app tags its own", () => {
    const entity = createFakeEntity();
    const { world, port, reports } = setup({ occludables: () => [asEntity(entity)] });
    port.applyOcclusion({ mode: "soft", scope: "tagged" });
    expect(world.getSystem(DepthSensingSystem)?.config["enableOcclusion"]?.value).toBe(true);
    expect(entity.hasComponent(DepthOccludable)).toBe(false);
    expect(reports.at(-1)?.detail).toContain("marked with DepthOccludable");
  });

  it("says why nothing will be occluded when nobody said what to occlude", () => {
    const { port, reports } = setup();
    port.applyOcclusion({ mode: "soft", scope: "all" });
    expect(reports.at(-1)?.state).toBe("unavailable");
    expect(reports.at(-1)?.detail).toContain("occludes per entity");
  });

  it("turns off cleanly when it was never on", () => {
    const { port, reports } = setup();
    port.applyOcclusion(null);
    expect(reports.at(-1)?.detail).toBe("occlusion is off");
  });
});

describe("light estimation", () => {
  it("says plainly that this host has none", () => {
    const { port, reports } = setup();
    port.applyLightEstimation({ ambient: true, key: true, ibl: true, shadows: false });
    expect(reports.at(-1)).toEqual({
      feature: "lightEstimation",
      state: "unsupported",
      detail: "IWSDK 0.5.3 does not expose WebXR light estimation",
    });

    port.applyLightEstimation(null);
    expect(reports.at(-1)?.detail).toBe("light estimation is off");
  });

  it("goes quiet once the director unsubscribes", () => {
    const { port, reports, stop } = setup();
    stop();
    port.applyLightEstimation(null);
    expect(reports).toHaveLength(0);
  });
});

describe("disposal", () => {
  it("takes the environment map and the occlusion opt-ins with it", () => {
    const entity = createFakeEntity();
    const { world, port } = setup({ occludables: () => [asEntity(entity)] });
    port.applyIbl({ kind: "room" });
    port.applyOcclusion({ mode: "soft", scope: "all" });

    port.dispose();
    expect(root(world).hasComponent(IBLTexture)).toBe(false);
    expect(entity.hasComponent(DepthOccludable)).toBe(false);
  });
});
