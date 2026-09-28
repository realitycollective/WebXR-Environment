/**
 * Binding cases for change 12: what a native host receives from the core
 * director through `NativeEnvironmentPort`, stated in `native-types.ts` and
 * proved here against a host that records every call in one ordered log.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OCCLUSION,
  EnvironmentDirector,
  NOON,
  type EnvironmentSpec,
  type SensingReport,
} from "@realitycollective/webxr-environment";
import { NativeEnvironmentPort } from "../src/environment-port.js";
import type { NativeEnvironmentHost } from "../src/native-types.js";

function recordingHost() {
  const log: Array<[string, unknown]> = [];
  const reports = new Set<(report: SensingReport) => void>();
  const report = (value: SensingReport) => {
    for (const listener of reports) listener(value);
  };
  const host: NativeEnvironmentHost = {
    onSensingReport: (listener) => {
      reports.add(listener);
      return () => reports.delete(listener);
    },
    applySky: (value) => log.push(["sky", value]),
    applyFog: (value) => log.push(["fog", value]),
    applyAmbient: (value) => log.push(["ambient", value]),
    applyKeyLight: (value) => log.push(["key", value]),
    applyIbl: (value) => log.push(["ibl", value]),
    applyOcclusion: (value) => log.push(["occlusion", value]),
  };
  const last = (slot: string) => [...log].reverse().find(([name]) => name === slot)?.[1];
  return { host, log, last, report };
}

const BRIGHT: EnvironmentSpec = { ...NOON, ambient: { colour: [1, 1, 1], intensity: 3 } };

describe("change 12: the slot semantics a native host receives", () => {
  it("receives the five slots in order: sky, fog, ambient, key, ibl", () => {
    const { host, log } = recordingHost();
    const director = new EnvironmentDirector(new NativeEnvironmentPort(host));
    log.length = 0;
    // Every slot changes, so every slot is flushed; the director sends only changed ones.
    director.apply({ ...NOON, ibl: { kind: "room" } });
    expect(log.map(([slot]) => slot)).toEqual(["sky", "fog", "ambient", "key", "ibl"]);
  });

  it("receives null for sky and fog while passthrough is on, the default suppression, and the spec back after", () => {
    const { host, last } = recordingHost();
    const director = new EnvironmentDirector(new NativeEnvironmentPort(host));
    director.apply(NOON);
    director.setPassthrough(true);
    expect(last("sky")).toBeNull();
    expect(last("fog")).toBeNull();
    expect(last("ambient")).toEqual(director.applied.ambient);
    director.setPassthrough(false);
    expect(last("sky")).toEqual(director.applied.sky);
    expect(last("fog")).toEqual(director.applied.fog);
  });

  it("receives the remembered occlusion spec on passthrough, and null for the sky alone once occlusion is active", () => {
    const { host, last, log, report } = recordingHost();
    const director = new EnvironmentDirector(new NativeEnvironmentPort(host), { passthroughSuppresses: [] });
    director.apply(NOON);
    director.setOcclusion(DEFAULT_OCCLUSION);
    expect(log.some(([slot]) => slot === "occlusion" && last("occlusion") !== null)).toBe(false);
    director.setPassthrough(true);
    expect(last("occlusion")).toEqual(DEFAULT_OCCLUSION);
    // Suppression waits for the host to report occlusion working, as on IWSDK.
    expect(last("sky")).toEqual(director.applied.sky);
    report({ feature: "occlusion", state: "active" });
    expect(last("sky")).toBeNull();
    expect(last("fog")).toEqual(director.applied.fog);
  });

  it("snaps with no duration: the default transition duration is 0", () => {
    const { host, last } = recordingHost();
    const director = new EnvironmentDirector(new NativeEnvironmentPort(host));
    director.apply(NOON);
    director.transition(BRIGHT);
    expect((last("ambient") as { intensity: number }).intensity).toBe(3);
  });

  for (const [easing, eased] of [
    ["linear", 0.5],
    ["easeIn", 0.25],
    ["easeOut", 0.75],
    ["easeInOut", 0.5],
  ] as const) {
    it(`hands the host the ${easing} curve's value halfway through`, () => {
      const { host, last } = recordingHost();
      const director = new EnvironmentDirector(new NativeEnvironmentPort(host));
      director.apply(NOON);
      director.transition(BRIGHT, { durationMs: 1000, easing });
      director.update(500);
      expect((last("ambient") as { intensity: number }).intensity).toBeCloseTo(1 + 2 * eased, 9);
    });
  }

  it("uses linear when the call names no easing", () => {
    const { host, last } = recordingHost();
    const director = new EnvironmentDirector(new NativeEnvironmentPort(host));
    director.apply(NOON);
    director.transition(BRIGHT, { durationMs: 1000 });
    director.update(250);
    expect((last("ambient") as { intensity: number }).intensity).toBeCloseTo(1.5, 9);
  });
});
