import { describe, expect, it } from "vitest";
import {
  AmbientLightComponent,
  DirectionalLightComponent,
  DomeGradient,
  Fog,
  FogExp2,
  Quaternion,
  Transform,
  Vector3,
} from "@iwsdk/core";
import type { SkySpec } from "@realitycollective/iwsdk-environment";
import { IWSDKEnvironmentPort } from "@realitycollective/iwsdk-environment";
import { asWorld, createFakeEntity, createFakeWorld, type FakeWorld } from "./helpers.js";

const GRADIENT: SkySpec = {
  kind: "gradient",
  top: [0, 0, 1],
  bottom: [1, 0, 0],
};

function setup(world: FakeWorld = createFakeWorld()) {
  return { world, port: new IWSDKEnvironmentPort(asWorld(world)) };
}

function root(world: FakeWorld) {
  const level = world.activeLevel.value;
  if (level === null) throw new Error("no level");
  return level;
}

describe("IWSDKEnvironmentPort", () => {
  describe("sky", () => {
    it("puts a DomeGradient on the level root", () => {
      const { world, port } = setup();
      port.applySky(GRADIENT);
      const level = root(world);
      expect(level.hasComponent(DomeGradient)).toBe(true);
      expect(Array.from(level.getVectorView(DomeGradient, "sky"))).toEqual([0, 0, 1, 1]);
      expect(Array.from(level.getVectorView(DomeGradient, "ground"))).toEqual([1, 0, 0, 1]);
      expect(level.getValue(DomeGradient, "intensity")).toBe(1);
      expect(level.getValue(DomeGradient, "_needsUpdate")).toBe(true);
    });

    it("derives the equator from the same ramp the three.js adapter uses", () => {
      // Both engines must agree at the horizon, not only at the poles.
      const { world, port } = setup();
      port.applySky(GRADIENT);
      expect(Array.from(root(world).getVectorView(DomeGradient, "equator"))).toEqual([
        0.5, 0, 0.5, 1,
      ]);

      port.applySky({ ...GRADIENT, exponent: 2 });
      const equator = Array.from(root(world).getVectorView(DomeGradient, "equator"));
      expect(equator[0]).toBeCloseTo(0.75);
      expect(equator[2]).toBeCloseTo(0.25);
    });

    it("flattens a solid sky across all three bands", () => {
      const { world, port } = setup();
      port.applySky({ kind: "solid", colour: [0.25, 0.5, 0.75] });
      const level = root(world);
      for (const band of ["sky", "equator", "ground"] as const) {
        expect(Array.from(level.getVectorView(DomeGradient, band))).toEqual([0.25, 0.5, 0.75, 1]);
      }
    });

    it("removes the dome when the sky goes away", () => {
      const { world, port } = setup();
      port.applySky(GRADIENT);
      port.applySky(null);
      expect(root(world).hasComponent(DomeGradient)).toBe(false);
      port.applySky(null);
      expect(root(world).hasComponent(DomeGradient)).toBe(false);
    });

    it("does nothing at all before a level exists", () => {
      // Components go on the level root, and there is no root until IWSDK has
      // loaded one. Throwing here would take out an app that set its
      // environment up before its first level.
      const world = createFakeWorld({ withLevel: false });
      const { port } = setup(world);
      expect(() => port.applySky(GRADIENT)).not.toThrow();
      expect(world.created).toHaveLength(0);
    });

    it("uses an explicit parent as the dome host", () => {
      const world = createFakeWorld();
      const parent = createFakeEntity();
      const port = new IWSDKEnvironmentPort(asWorld(world), { parent: parent as never });
      port.applySky(GRADIENT);
      expect(parent.hasComponent(DomeGradient)).toBe(true);
      expect(root(world).hasComponent(DomeGradient)).toBe(false);
    });

    it("honours a custom sky intensity", () => {
      const world = createFakeWorld();
      const port = new IWSDKEnvironmentPort(asWorld(world), { skyIntensity: 0.4 });
      port.applySky(GRADIENT);
      expect(root(world).getValue(DomeGradient, "intensity")).toBe(0.4);
    });
  });

  describe("fog", () => {
    it("sets each kind on the scene, since IWSDK has no fog component", () => {
      const { world, port } = setup();
      port.applyFog({ kind: "linear", colour: [1, 1, 1], near: 4, far: 40 });
      expect(world.scene.fog).toBeInstanceOf(Fog);
      expect((world.scene.fog as Fog).far).toBe(40);

      port.applyFog({ kind: "exponential", colour: [1, 0, 0], density: 0.3 });
      expect(world.scene.fog).toBeInstanceOf(FogExp2);
      expect((world.scene.fog as FogExp2).color.getHexString()).toBe("ff0000");
    });

    it("mutates rather than rebuilding when only the numbers moved", () => {
      const { world, port } = setup();
      port.applyFog({ kind: "linear", colour: [1, 1, 1], near: 4, far: 40 });
      const first = world.scene.fog;
      port.applyFog({ kind: "linear", colour: [0, 0, 0], near: 5, far: 50 });
      expect(world.scene.fog).toBe(first);
      expect((world.scene.fog as Fog).near).toBe(5);

      port.applyFog({ kind: "exponential", colour: [1, 1, 1], density: 0.1 });
      const exp = world.scene.fog;
      port.applyFog({ kind: "exponential", colour: [1, 1, 1], density: 0.2 });
      expect(world.scene.fog).toBe(exp);
      expect((world.scene.fog as FogExp2).density).toBeCloseTo(0.2);
    });

    it("clears the fog and rebuilds after", () => {
      const { world, port } = setup();
      port.applyFog({ kind: "linear", colour: [1, 1, 1], near: 4, far: 40 });
      port.applyFog(null);
      expect(world.scene.fog).toBeNull();
      port.applyFog({ kind: "linear", colour: [1, 1, 1], near: 4, far: 40 });
      expect(world.scene.fog).toBeInstanceOf(Fog);
    });
  });

  describe("lights", () => {
    it("creates one entity for the ambient light and reuses it", () => {
      const { world, port } = setup();
      port.applyAmbient({ colour: [1, 1, 0], intensity: 2 });
      expect(world.created).toHaveLength(1);
      const entity = world.created[0]!;
      expect(Array.from(entity.getVectorView(AmbientLightComponent, "color"))).toEqual([
        1, 1, 0, 1,
      ]);
      expect(entity.getValue(AmbientLightComponent, "intensity")).toBe(2);

      port.applyAmbient({ colour: [0, 0, 0], intensity: 0.5 });
      expect(world.created).toHaveLength(1);
      expect(entity.getValue(AmbientLightComponent, "intensity")).toBe(0.5);
    });

    it("destroys the ambient entity when the light is removed", () => {
      const { world, port } = setup();
      port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
      port.applyAmbient(null);
      expect(world.created[0]?.destroyed).toBe(true);
      port.applyAmbient(null);
      port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
      expect(world.created).toHaveLength(2);
    });

    it("rotates the key entity so its local -Z runs along the direction", () => {
      const { world, port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 3, direction: [0, -1, 0] });
      const entity = world.created[0]!;
      expect(entity.getValue(DirectionalLightComponent, "intensity")).toBe(3);
      expect(entity.getValue(DirectionalLightComponent, "castShadow")).toBe(false);

      const orientation = entity.getVectorView(Transform, "orientation");
      const forward = new Vector3(0, 0, -1).applyQuaternion(
        new Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]),
      );
      expect(forward.x).toBeCloseTo(0);
      expect(forward.y).toBeCloseTo(-1);
      expect(forward.z).toBeCloseTo(0);
    });

    it("normalises the direction and carries castShadow through", () => {
      const { world, port } = setup();
      port.applyKeyLight({
        colour: [1, 1, 1],
        intensity: 1,
        direction: [0, 0, -8],
        castShadow: true,
      });
      const entity = world.created[0]!;
      expect(entity.getValue(DirectionalLightComponent, "castShadow")).toBe(true);
      const orientation = Array.from(entity.getVectorView(Transform, "orientation"));
      // -Z is already the light's forward, so the rotation is the identity.
      expect(orientation).toEqual([0, 0, 0, 1]);
    });

    it("points straight down for a zero-length direction rather than a NaN", () => {
      const { world, port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, 0, 0] });
      const orientation = world.created[0]!.getVectorView(Transform, "orientation");
      expect(Number.isNaN(orientation[0])).toBe(false);
      const forward = new Vector3(0, 0, -1).applyQuaternion(
        new Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]),
      );
      expect(forward.y).toBeCloseTo(-1);
    });

    it("destroys the key entity when the light is removed", () => {
      const { world, port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] });
      port.applyKeyLight(null);
      expect(world.created[0]?.destroyed).toBe(true);
      port.applyKeyLight(null);
    });

    it("parents the light entities under the level root", () => {
      const { world, port } = setup();
      port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
      expect(world.created[0]?.parent).toBe(world.activeLevel.value);
    });

    it("still creates a light entity when there is no level yet", () => {
      const world = createFakeWorld({ withLevel: false });
      const { port } = setup(world);
      port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
      expect(world.created).toHaveLength(1);
      expect(world.created[0]?.parent).toBeUndefined();
    });
  });

  it("gives everything back on dispose", () => {
    const { world, port } = setup();
    port.applySky(GRADIENT);
    port.applyFog({ kind: "linear", colour: [1, 1, 1], near: 1, far: 2 });
    port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
    port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] });

    port.dispose();

    expect(root(world).hasComponent(DomeGradient)).toBe(false);
    expect(world.scene.fog).toBeNull();
    expect(world.created.every((entity) => entity.destroyed)).toBe(true);
  });
});
