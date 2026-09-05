import { describe, expect, it } from "vitest";
import { EquirectangularReflectionMapping, SRGBColorSpace } from "three";
import type { SkyGradient } from "@realitycollective/threejs-environment";
import {
  createSkyTexture,
  gradientPixels,
  skyMix,
  SKY_TEXTURE_WIDTH,
} from "@realitycollective/threejs-environment";

const PLAIN: SkyGradient = { kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] };

describe("skyMix", () => {
  it("runs from the bottom colour at the nadir to the top colour at the zenith", () => {
    expect(skyMix(PLAIN, 0)).toBe(0);
    expect(skyMix(PLAIN, 0.5)).toBeCloseTo(0.5);
    expect(skyMix(PLAIN, 1)).toBe(1);
  });

  it("clamps out-of-range heights", () => {
    expect(skyMix(PLAIN, -1)).toBe(0);
    expect(skyMix(PLAIN, 2)).toBe(1);
  });

  it("slides the meeting point with horizon", () => {
    const low: SkyGradient = { ...PLAIN, horizon: 0.25 };
    expect(skyMix(low, 0.25)).toBeCloseTo(0.5);
    expect(skyMix(low, 0.125)).toBeCloseTo(0.25);
    expect(skyMix(low, 0.625)).toBeCloseTo(0.75);
  });

  it("shapes the ramp with exponent", () => {
    expect(skyMix({ ...PLAIN, exponent: 2 }, 0.5)).toBeCloseTo(0.25);
    expect(skyMix({ ...PLAIN, exponent: 1 }, 0.5)).toBeCloseTo(0.5);
  });

  it("survives a horizon pushed to either extreme", () => {
    // A horizon at 0 is the one division by zero reachable here, and it can
    // only be reached at the nadir, where the answer is the midpoint - the
    // colour AT the horizon. Everything above then ramps midpoint -> top.
    expect(skyMix({ ...PLAIN, horizon: 0 }, 0)).toBe(0.5);
    expect(skyMix({ ...PLAIN, horizon: 0 }, 0.5)).toBeCloseTo(0.75);
    expect(skyMix({ ...PLAIN, horizon: 0 }, 1)).toBe(1);
    // A horizon at the zenith is never crossed, so the whole dome ramps
    // bottom -> midpoint and the top colour is never reached.
    expect(skyMix({ ...PLAIN, horizon: 1 }, 0)).toBe(0);
    expect(skyMix({ ...PLAIN, horizon: 1 }, 0.5)).toBeCloseTo(0.25);
    expect(skyMix({ ...PLAIN, horizon: 1 }, 1)).toBe(0.5);
  });
});

describe("gradientPixels", () => {
  it("fills RGBA rows from the nadir upwards", () => {
    // three.js maps an equirect background with v=1 at the zenith, and a
    // DataTexture does not flip, so the LAST row must be the top colour. Get
    // this backwards and the sky is upside down only on a headset.
    const pixels = gradientPixels(PLAIN, 4);
    expect(pixels).toHaveLength(SKY_TEXTURE_WIDTH * 4 * 4);
    expect(pixels[0]).toBeLessThan(64);
    expect(pixels.at(-4)).toBeGreaterThan(192);
    expect(pixels[3]).toBe(255);
  });

  it("writes the same colour across every column of a row", () => {
    const pixels = gradientPixels(PLAIN, 2);
    expect(pixels[0]).toBe(pixels[4]);
    expect(pixels[1]).toBe(pixels[5]);
    expect(pixels[2]).toBe(pixels[6]);
  });

  it("clamps colours outside 0..1 instead of wrapping them", () => {
    const pixels = gradientPixels(
      { kind: "gradient", top: [2, 2, 2], bottom: [-1, -1, -1] },
      2,
    );
    expect(pixels[0]).toBe(0);
    expect(pixels.at(-4)).toBe(255);
  });
});

describe("createSkyTexture", () => {
  it("is an sRGB equirectangular texture ready to use as a background", () => {
    const texture = createSkyTexture(PLAIN, 8);
    expect(texture.mapping).toBe(EquirectangularReflectionMapping);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    // `needsUpdate` is write-only on a three.js texture; the version counter
    // is what it moves, and a texture at version 0 has never been uploaded.
    expect(texture.version).toBeGreaterThan(0);
    expect(texture.image.width).toBe(SKY_TEXTURE_WIDTH);
    expect(texture.image.height).toBe(8);
    texture.dispose();
  });
});
