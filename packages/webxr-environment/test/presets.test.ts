import { describe, expect, it } from "vitest";
import type { FogSpec } from "@realitycollective/webxr-environment";
import {
  clearedFog,
  EnvironmentDirector,
  STOCK_PRESETS,
} from "@realitycollective/webxr-environment";
import { RecordingEnvironmentPort } from "./helpers.js";

describe("stock presets", () => {
  it("are all applicable and name themselves consistently", () => {
    const port = new RecordingEnvironmentPort();
    const director = new EnvironmentDirector(port, { presets: STOCK_PRESETS });
    for (const name of Object.keys(STOCK_PRESETS)) {
      director.apply(name);
    }
    expect(director.presetNames()).toEqual(Object.keys(STOCK_PRESETS));
  });
});

describe("clearedFog", () => {
  it("pushes linear fog out of sight while keeping its colour", () => {
    // This is the documented way to ease fog IN: both ends are then linear
    // fogs, so the slot interpolates instead of snapping.
    const fog: FogSpec = { kind: "linear", colour: [1, 0, 0], near: 5, far: 50 };
    expect(clearedFog(fog)).toEqual({
      kind: "linear",
      colour: [1, 0, 0],
      near: 100_000,
      far: 200_000,
    });
    expect(clearedFog(fog, 10)).toEqual({
      kind: "linear",
      colour: [1, 0, 0],
      near: 10,
      far: 20,
    });
  });

  it("zeroes the density of exponential fog", () => {
    const fog: FogSpec = { kind: "exponential", colour: [0, 1, 0], density: 0.2 };
    expect(clearedFog(fog)).toEqual({ kind: "exponential", colour: [0, 1, 0], density: 0 });
  });

  it("interpolates cleanly from cleared to full", () => {
    const port = new RecordingEnvironmentPort();
    const fog: FogSpec = { kind: "linear", colour: [1, 1, 1], near: 0, far: 100 };
    const director = new EnvironmentDirector(port, { initial: { fog: clearedFog(fog, 1000) } });
    director.transition({ fog }, { durationMs: 1000 });
    director.update(500);
    expect(director.current.fog).toEqual({
      kind: "linear",
      colour: [1, 1, 1],
      near: 500,
      far: 1050,
    });
  });
});
