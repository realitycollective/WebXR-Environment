import { describe, expect, it } from "vitest";
import { AmbientLight, Color, DirectionalLight, Fog, FogExp2, Group, Scene } from "three";
import type { FogSpec, SkySpec } from "@realitycollective/threejs-environment";
import { ThreeEnvironmentPort, createThreeEnvironment } from "@realitycollective/threejs-environment";

const GRADIENT: SkySpec = { kind: "gradient", top: [0, 0, 1], bottom: [1, 1, 1] };

function setup() {
  const scene = new Scene();
  return { scene, port: new ThreeEnvironmentPort(scene) };
}

function ambientOf(port: ThreeEnvironmentPort): AmbientLight | undefined {
  return port.root.children.find((child): child is AmbientLight => child instanceof AmbientLight);
}

function keyOf(port: ThreeEnvironmentPort): DirectionalLight | undefined {
  return port.root.children.find(
    (child): child is DirectionalLight => child instanceof DirectionalLight,
  );
}

describe("ThreeEnvironmentPort", () => {
  it("parents everything it makes under one named group", () => {
    const { scene, port } = setup();
    expect(scene.children).toContain(port.root);
    expect(port.root).toBeInstanceOf(Group);
    expect(port.root.name).toBe("webxr-environment");
  });

  it("honours a custom parent", () => {
    const scene = new Scene();
    const parent = new Group();
    scene.add(parent);
    const port = new ThreeEnvironmentPort(scene, { parent });
    expect(parent.children).toContain(port.root);
    expect(scene.children).not.toContain(port.root);
  });

  describe("sky", () => {
    it("sets a solid colour background", () => {
      const { scene, port } = setup();
      port.applySky({ kind: "solid", colour: [1, 0, 0] });
      expect(scene.background).toBeInstanceOf(Color);
      expect((scene.background as Color).getHexString()).toBe("ff0000");
    });

    it("sets a generated texture for a gradient", () => {
      const { scene, port } = setup();
      port.applySky(GRADIENT);
      expect(scene.background).toHaveProperty("isTexture", true);
    });

    it("reuses the texture across a transition instead of reallocating", () => {
      // The director pushes a new gradient on every frame of a fade; a fresh
      // DataTexture per frame would be a GPU upload per frame for no reason.
      const { scene, port } = setup();
      port.applySky(GRADIENT);
      const first = scene.background;
      port.applySky({ ...GRADIENT, top: [0, 1, 0] });
      expect(scene.background).toBe(first);
    });

    it("releases the texture when the sky goes away", () => {
      const { scene, port } = setup();
      port.applySky(GRADIENT);
      port.applySky(null);
      expect(scene.background).toBeNull();
      port.applySky(GRADIENT);
      port.applySky({ kind: "solid", colour: [0, 0, 0] });
      expect(scene.background).toBeInstanceOf(Color);
    });
  });

  describe("fog", () => {
    const linear: FogSpec = { kind: "linear", colour: [1, 1, 1], near: 5, far: 50 };
    const exponential: FogSpec = { kind: "exponential", colour: [1, 0, 0], density: 0.1 };

    it("creates each kind", () => {
      const { scene, port } = setup();
      port.applyFog(linear);
      expect(scene.fog).toBeInstanceOf(Fog);
      expect((scene.fog as Fog).far).toBe(50);

      port.applyFog(exponential);
      expect(scene.fog).toBeInstanceOf(FogExp2);
      expect((scene.fog as FogExp2).density).toBeCloseTo(0.1);
    });

    it("mutates the existing fog when only its numbers moved", () => {
      const { scene, port } = setup();
      port.applyFog(linear);
      const first = scene.fog;
      port.applyFog({ ...linear, near: 10 });
      expect(scene.fog).toBe(first);
      expect((scene.fog as Fog).near).toBe(10);

      port.applyFog(exponential);
      const exp = scene.fog;
      port.applyFog({ ...exponential, density: 0.2 });
      expect(scene.fog).toBe(exp);
      expect((scene.fog as FogExp2).density).toBeCloseTo(0.2);
    });

    it("rebuilds when the fog is cleared and set again", () => {
      const { scene, port } = setup();
      port.applyFog(linear);
      port.applyFog(null);
      expect(scene.fog).toBeNull();
      port.applyFog(linear);
      expect(scene.fog).toBeInstanceOf(Fog);
    });
  });

  describe("lights", () => {
    it("adds, updates and removes the ambient light", () => {
      const { port } = setup();
      port.applyAmbient({ colour: [1, 1, 1], intensity: 2 });
      expect(ambientOf(port)?.intensity).toBe(2);

      port.applyAmbient({ colour: [1, 0, 0], intensity: 3 });
      expect(port.root.children.filter((child) => child instanceof AmbientLight)).toHaveLength(1);
      expect(ambientOf(port)?.intensity).toBe(3);

      port.applyAmbient(null);
      expect(ambientOf(port)).toBeUndefined();
      port.applyAmbient(null);
      expect(ambientOf(port)).toBeUndefined();
    });

    it("places the key light opposite the direction light travels", () => {
      const { port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] });
      const light = keyOf(port);
      // Light travelling downwards comes from above.
      expect(light?.position.y).toBeCloseTo(50);
      expect(light?.castShadow).toBe(false);
    });

    it("normalises the direction and honours castShadow", () => {
      const { port } = setup();
      port.applyKeyLight({
        colour: [1, 1, 1],
        intensity: 1,
        direction: [0, -10, 0],
        castShadow: true,
      });
      expect(keyOf(port)?.position.y).toBeCloseTo(50);
      expect(keyOf(port)?.castShadow).toBe(true);
    });

    it("falls back to overhead for a zero-length direction rather than a NaN", () => {
      const { port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, 0, 0] });
      expect(keyOf(port)?.position.toArray()).toEqual([0, 50, 0]);
    });

    it("removes the key light", () => {
      const { port } = setup();
      port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] });
      port.applyKeyLight(null);
      expect(keyOf(port)).toBeUndefined();
      port.applyKeyLight(null);
      expect(keyOf(port)).toBeUndefined();
    });
  });

  it("gives everything back on dispose", () => {
    const { scene, port } = setup();
    port.applySky(GRADIENT);
    port.applyFog({ kind: "linear", colour: [0, 0, 0], near: 1, far: 2 });
    port.applyAmbient({ colour: [1, 1, 1], intensity: 1 });
    port.applyKeyLight({ colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] });

    port.dispose();

    expect(scene.background).toBeNull();
    expect(scene.fog).toBeNull();
    expect(scene.children).not.toContain(port.root);
    expect(port.root.children).toHaveLength(0);
  });
});

describe("createThreeEnvironment", () => {
  it("wires a director to the scene and drives it from update", () => {
    const scene = new Scene();
    const { director, port } = createThreeEnvironment(scene, {
      presets: { day: { sky: { kind: "solid", colour: [1, 1, 1] } } },
      initial: { sky: { kind: "solid", colour: [0, 0, 0] } },
      skyResolution: 8,
    });

    expect(scene.background).toBeInstanceOf(Color);
    director.transition("day", { durationMs: 100 });
    director.update(50);
    expect((scene.background as Color).getHexString()).not.toBe("000000");
    director.update(50);
    expect((scene.background as Color).getHexString()).toBe("ffffff");

    director.dispose();
    expect(scene.children).not.toContain(port.root);
  });
});
