/**
 * The attenuation defaults and the listener rule (`src/audio.ts`): Web
 * Audio's panner values, resolved once in the core so every platform applies
 * them, and the distance models a host is checked against.
 */
import { describe, expect, it } from "vitest";
import { AUDIO_ATTENUATION_DEFAULTS, AUDIO_LISTENER_RULE, distanceGain, resolveAudioSpatial } from "../src/index.js";

describe("audio attenuation defaults", () => {
  it("are Web Audio's panner defaults, with a full cone in radians", () => {
    expect(AUDIO_ATTENUATION_DEFAULTS.model).toBe("inverse");
    expect(AUDIO_ATTENUATION_DEFAULTS.refDistance).toBe(1);
    expect(AUDIO_ATTENUATION_DEFAULTS.rolloffFactor).toBe(1);
    expect(AUDIO_ATTENUATION_DEFAULTS.maxDistance).toBe(10000);
    expect(AUDIO_ATTENUATION_DEFAULTS.cone).toEqual({ inner: 2 * Math.PI, outer: 2 * Math.PI, outsideGain: 0 });
    expect(AUDIO_LISTENER_RULE).toBe("head");
  });

  it("resolve fills only what a cue left out, and hands back fresh objects", () => {
    expect(resolveAudioSpatial(null)).toEqual(AUDIO_ATTENUATION_DEFAULTS);
    expect(resolveAudioSpatial(undefined)).toEqual(AUDIO_ATTENUATION_DEFAULTS);
    const cone = { inner: 1, outer: 2, outsideGain: 0.5 };
    const resolved = resolveAudioSpatial({ refDistance: 3, cone });
    expect(resolved).toEqual({ refDistance: 3, rolloffFactor: 1, maxDistance: 10000, model: "inverse", cone });
    expect(resolved.cone).not.toBe(cone);
    expect(resolveAudioSpatial(null).cone).not.toBe(AUDIO_ATTENUATION_DEFAULTS.cone);
  });

  it("distanceGain follows the three Web Audio models", () => {
    // Inverse from 1 m: full within 1 m, half at 2 m, a third at 3 m.
    expect(distanceGain(0.5, null)).toBe(1);
    expect(distanceGain(2, null)).toBeCloseTo(0.5, 6);
    expect(distanceGain(3, null)).toBeCloseTo(1 / 3, 6);
    expect(distanceGain(3, { refDistance: 1, rolloffFactor: 2 })).toBeCloseTo(0.2, 6);
    // Linear: falls to 0 at maxDistance, and stays there.
    expect(distanceGain(5.5, { model: "linear", maxDistance: 10 })).toBeCloseTo(0.5, 6);
    expect(distanceGain(50, { model: "linear", maxDistance: 10 })).toBe(0);
    expect(distanceGain(1, { model: "linear", maxDistance: 1 })).toBe(1);
    // Exponential: (d / ref) ^ -rolloff, clamped at maxDistance.
    expect(distanceGain(4, { model: "exponential" })).toBeCloseTo(0.25, 6);
    expect(distanceGain(100, { model: "exponential", maxDistance: 4 })).toBeCloseTo(0.25, 6);
  });
});
