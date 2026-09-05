import { describe, expect, it } from "vitest";
import type {
  FogSpec,
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
