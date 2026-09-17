import { describe, expect, it } from "vitest";
import {
  clamp,
  clamp01,
  lerp,
  lerpRgb,
  resolveEasing,
  rgbEquals,
  rgbFromHex,
  rgbToHex,
} from "@realitycollective/webxr-environment";

describe("math", () => {
  it("clamps", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(1, 0, 3)).toBe(1);
  });

  it("interpolates numbers and colours", () => {
    expect(lerp(0, 10, 0.25)).toBe(2.5);
    expect(lerpRgb([0, 0, 0], [1, 1, 1], 0.5)).toEqual([0.5, 0.5, 0.5]);
  });

  it("compares colours by value", () => {
    expect(rgbEquals([0.1, 0.2, 0.3], [0.1, 0.2, 0.3])).toBe(true);
    expect(rgbEquals([0.1, 0.2, 0.3], [0.1, 0.2, 0.4])).toBe(false);
  });

  it("round-trips hex", () => {
    expect(rgbFromHex(0xff0000)).toEqual([1, 0, 0]);
    expect(rgbToHex([1, 0, 0])).toBe(0xff0000);
    expect(rgbToHex(rgbFromHex(0x3a7bd5))).toBe(0x3a7bd5);
    // Out-of-range channels are clamped rather than wrapping into the
    // neighbouring byte, which would turn a slightly over-bright red green.
    expect(rgbToHex([2, -1, 0.5])).toBe(0xff0080);
  });

  it("resolves easings, and treats an unknown name as linear", () => {
    expect(resolveEasing("linear")(0.4)).toBeCloseTo(0.4);
    expect(resolveEasing("easeIn")(0.5)).toBeCloseTo(0.25);
    expect(resolveEasing("easeOut")(0.5)).toBeCloseTo(0.75);
    expect(resolveEasing("easeInOut")(0.25)).toBeCloseTo(0.125);
    expect(resolveEasing("easeInOut")(0.75)).toBeCloseTo(0.875);
    expect(resolveEasing(undefined)(0.6)).toBeCloseTo(0.6);
    expect(resolveEasing("nonsense" as "linear")(0.6)).toBeCloseTo(0.6);
    expect(resolveEasing((t) => t * 3)(0.2)).toBeCloseTo(0.6);
  });
});
