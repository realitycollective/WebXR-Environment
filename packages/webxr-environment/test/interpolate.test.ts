import { describe, expect, it } from "vitest";
import type {
  FogSpec,
  IblSpec,
  ResolvedEnvironment,
  SkySpec,
} from "@realitycollective/webxr-environment";
import { EMPTY_ENVIRONMENT, interpolateEnvironment } from "@realitycollective/webxr-environment";

const GRADIENT_A: SkySpec = { kind: "gradient", top: [0, 0, 0], bottom: [1, 1, 1] };
const GRADIENT_B: SkySpec = {
  kind: "gradient",
  top: [1, 1, 1],
  bottom: [0, 0, 0],
  horizon: 0.25,
  exponent: 2,
};
const SOLID: SkySpec = { kind: "solid", colour: [1, 0, 0] };
const FOG_NEAR: FogSpec = { kind: "linear", colour: [0, 0, 0], near: 0, far: 100 };
const FOG_FAR: FogSpec = { kind: "linear", colour: [1, 1, 1], near: 10, far: 200 };
const FOG_EXP: FogSpec = { kind: "exponential", colour: [0, 0, 0], density: 0.1 };

function env(partial: Partial<ResolvedEnvironment>): ResolvedEnvironment {
  return { ...EMPTY_ENVIRONMENT, ...partial };
}

describe("interpolateEnvironment", () => {
  it("returns the target at t >= 1 without copying", () => {
    const to = env({ sky: GRADIENT_B });
    expect(interpolateEnvironment(env({ sky: GRADIENT_A }), to, 1)).toBe(to);
    expect(interpolateEnvironment(env({ sky: GRADIENT_A }), to, 2)).toBe(to);
  });

  it("blends two gradient skies, defaults included", () => {
    const mid = interpolateEnvironment(env({ sky: GRADIENT_A }), env({ sky: GRADIENT_B }), 0.5);
    expect(mid.sky).toEqual({
      kind: "gradient",
      top: [0.5, 0.5, 0.5],
      bottom: [0.5, 0.5, 0.5],
      // GRADIENT_A omits both, so it contributes the documented defaults.
      horizon: 0.375,
      exponent: 1.5,
      intensity: 1,
    });
  });

  it("blends two solid skies", () => {
    const mid = interpolateEnvironment(
      env({ sky: { kind: "solid", colour: [0, 0, 0] } }),
      env({ sky: SOLID }),
      0.5,
    );
    expect(mid.sky).toEqual({ kind: "solid", colour: [0.5, 0, 0] });
  });

  it("snaps a slot whose kind changes, from the very first frame", () => {
    const start = interpolateEnvironment(env({ sky: GRADIENT_A }), env({ sky: SOLID }), 0);
    expect(start.sky).toBe(SOLID);
    const mid = interpolateEnvironment(env({ sky: GRADIENT_A }), env({ sky: SOLID }), 0.5);
    expect(mid.sky).toBe(SOLID);
  });

  it("snaps a slot that appears or disappears", () => {
    expect(interpolateEnvironment(EMPTY_ENVIRONMENT, env({ fog: FOG_NEAR }), 0).fog).toBe(FOG_NEAR);
    expect(interpolateEnvironment(env({ fog: FOG_NEAR }), EMPTY_ENVIRONMENT, 0).fog).toBeNull();
  });

  it("blends both fog kinds", () => {
    const linear = interpolateEnvironment(env({ fog: FOG_NEAR }), env({ fog: FOG_FAR }), 0.5);
    expect(linear.fog).toEqual({
      kind: "linear",
      colour: [0.5, 0.5, 0.5],
      near: 5,
      far: 150,
    });
    const exponential = interpolateEnvironment(
      env({ fog: { kind: "exponential", colour: [1, 1, 1], density: 0 } }),
      env({ fog: FOG_EXP }),
      0.5,
    );
    expect(exponential.fog).toEqual({
      kind: "exponential",
      colour: [0.5, 0.5, 0.5],
      density: 0.05,
    });
  });

  it("blends lights, and takes the target's shadow flag at once", () => {
    const mid = interpolateEnvironment(
      env({
        ambient: { colour: [0, 0, 0], intensity: 0 },
        key: { colour: [0, 0, 0], intensity: 0, direction: [0, -1, 0] },
      }),
      env({
        ambient: { colour: [1, 1, 1], intensity: 2 },
        key: { colour: [1, 1, 1], intensity: 4, direction: [0, 1, 0], castShadow: true },
      }),
      0.5,
    );
    expect(mid.ambient).toEqual({ colour: [0.5, 0.5, 0.5], intensity: 1 });
    expect(mid.key).toEqual({
      colour: [0.5, 0.5, 0.5],
      intensity: 2,
      direction: [0, 0, 0],
      castShadow: true,
    });
  });

  it("omits castShadow entirely when the target does not set it", () => {
    const mid = interpolateEnvironment(
      env({ key: { colour: [0, 0, 0], intensity: 0, direction: [0, -1, 0], castShadow: true } }),
      env({ key: { colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] } }),
      0.5,
    );
    expect(mid.key && "castShadow" in mid.key).toBe(false);
  });

});

describe("the kinds added for image-based lighting and authored skies", () => {
  const TEXTURE_A: SkySpec = { kind: "texture", src: "sky.hdr" };
  const TEXTURE_B: SkySpec = {
    kind: "texture",
    src: "sky.hdr",
    intensity: 2,
    rotationY: Math.PI,
    blur: 1,
  };
  const IBL_A: IblSpec = { kind: "gradient", top: [0, 0, 0], bottom: [1, 1, 1] };
  const IBL_B: IblSpec = {
    kind: "gradient",
    top: [1, 1, 1],
    bottom: [0, 0, 0],
    intensity: 3,
    rotationY: 2,
  };

  it("moves the numbers of one image and snaps between two", () => {
    const mid = interpolateEnvironment(env({ sky: TEXTURE_A }), env({ sky: TEXTURE_B }), 0.5);
    expect(mid.sky).toEqual({
      kind: "texture",
      src: "sky.hdr",
      intensity: 1.5,
      rotationY: Math.PI / 2,
      blur: 0.5,
    });

    const swapped = interpolateEnvironment(
      env({ sky: TEXTURE_A }),
      env({ sky: { kind: "texture", src: "other.hdr" } }),
      0.5,
    );
    expect(swapped.sky).toEqual({ kind: "texture", src: "other.hdr" });
  });

  it("interpolates a horizon stop only when both ends have one", () => {
    const both = interpolateEnvironment(
      env({ sky: { kind: "gradient", top: [0, 0, 0], bottom: [0, 0, 0], equator: [0, 0, 0] } }),
      env({ sky: { kind: "gradient", top: [1, 1, 1], bottom: [1, 1, 1], equator: [1, 1, 1] } }),
      0.5,
    );
    expect((both.sky as { equator: unknown }).equator).toEqual([0.5, 0.5, 0.5]);

    const gained = interpolateEnvironment(
      env({ sky: { kind: "gradient", top: [0, 0, 0], bottom: [0, 0, 0] } }),
      env({ sky: { kind: "gradient", top: [1, 1, 1], bottom: [1, 1, 1], equator: [1, 0, 0] } }),
      0.5,
    );
    expect((gained.sky as { equator: unknown }).equator).toEqual([1, 0, 0]);

    const lost = interpolateEnvironment(
      env({ sky: { kind: "gradient", top: [0, 0, 0], bottom: [0, 0, 0], equator: [1, 0, 0] } }),
      env({ sky: { kind: "gradient", top: [1, 1, 1], bottom: [1, 1, 1] } }),
      0.5,
    );
    expect(lost.sky).not.toHaveProperty("equator");
  });

  it("blends two gradient environment maps", () => {
    const mid = interpolateEnvironment(env({ ibl: IBL_A }), env({ ibl: IBL_B }), 0.5);
    expect(mid.ibl).toEqual({
      kind: "gradient",
      top: [0.5, 0.5, 0.5],
      bottom: [0.5, 0.5, 0.5],
      intensity: 2,
      rotationY: 1,
    });
  });

  it("blends a room probe and snaps between kinds", () => {
    const mid = interpolateEnvironment(
      env({ ibl: { kind: "room" } }),
      env({ ibl: { kind: "room", intensity: 2, rotationY: 4 } }),
      0.5,
    );
    expect(mid.ibl).toEqual({ kind: "room", intensity: 1.5, rotationY: 2 });

    const swapped = interpolateEnvironment(env({ ibl: IBL_A }), env({ ibl: { kind: "room" } }), 0.5);
    expect(swapped.ibl).toEqual({ kind: "room" });

    const gone = interpolateEnvironment(env({ ibl: IBL_A }), env({}), 0.5);
    expect(gone.ibl).toBeNull();
  });

  it("moves the numbers of one environment texture and snaps between two", () => {
    const mid = interpolateEnvironment(
      env({ ibl: { kind: "texture", src: "room.hdr" } }),
      env({ ibl: { kind: "texture", src: "room.hdr", intensity: 2, rotationY: 2 } }),
      0.5,
    );
    expect(mid.ibl).toEqual({ kind: "texture", src: "room.hdr", intensity: 1.5, rotationY: 1 });

    const swapped = interpolateEnvironment(
      env({ ibl: { kind: "texture", src: "room.hdr" } }),
      env({ ibl: { kind: "texture", src: "other.hdr" } }),
      0.5,
    );
    expect(swapped.ibl).toEqual({ kind: "texture", src: "other.hdr" });
  });

  it("falls back to the documented defaults in either direction", () => {
    // The forward cases above have the DEFAULTS on the left. These have them
    // on the right, which is a different branch and the one a fade-out takes.
    const sky = interpolateEnvironment(env({ sky: TEXTURE_B }), env({ sky: TEXTURE_A }), 0.5);
    expect(sky.sky).toEqual({
      kind: "texture",
      src: "sky.hdr",
      intensity: 1.5,
      rotationY: Math.PI / 2,
      blur: 0.5,
    });

    const room = interpolateEnvironment(
      env({ ibl: { kind: "room", intensity: 2, rotationY: 4 } }),
      env({ ibl: { kind: "room" } }),
      0.5,
    );
    expect(room.ibl).toEqual({ kind: "room", intensity: 1.5, rotationY: 2 });

    const texture = interpolateEnvironment(
      env({ ibl: { kind: "texture", src: "room.hdr", intensity: 2, rotationY: 2 } }),
      env({ ibl: { kind: "texture", src: "room.hdr" } }),
      0.5,
    );
    expect(texture.ibl).toEqual({ kind: "texture", src: "room.hdr", intensity: 1.5, rotationY: 1 });
  });

  it("moves the numbers of a measured environment map without blending it", () => {
    const mid = interpolateEnvironment(
      env({ ibl: { kind: "estimated" } }),
      env({ ibl: { kind: "estimated", intensity: 2, rotationY: 4 } }),
      0.5,
    );
    // What it points at is a live texture and cannot be blended; how bright
    // and how turned it is can.
    expect(mid.ibl).toEqual({ kind: "estimated", intensity: 1.5, rotationY: 2 });

    const swapped = interpolateEnvironment(
      env({ ibl: { kind: "estimated" } }),
      env({ ibl: { kind: "room" } }),
      0.5,
    );
    expect(swapped.ibl).toEqual({ kind: "room" });
  });

  it("carries the equator through an environment map too", () => {
    const mid = interpolateEnvironment(
      env({ ibl: { kind: "gradient", top: [0, 0, 0], bottom: [0, 0, 0], equator: [0, 0, 0] } }),
      env({ ibl: { kind: "gradient", top: [1, 1, 1], bottom: [1, 1, 1], equator: [1, 1, 1] } }),
      0.5,
    );
    expect((mid.ibl as { equator: unknown }).equator).toEqual([0.5, 0.5, 0.5]);
  });
});
