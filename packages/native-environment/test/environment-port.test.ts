import { describe, expect, it } from "vitest";
import type {
  AmbientLightSpec,
  EstimatedLighting,
  FogSpec,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  SensingReport,
  SkySpec,
} from "@realitycollective/webxr-environment";
import { NativeEnvironmentPort } from "../src/environment-port.js";
import { createFakeEnvironmentHost } from "./helpers.js";

const SKY: SkySpec = { kind: "solid", colour: [0.1, 0.2, 0.3] };
const FOG: FogSpec = { kind: "linear", colour: [0, 0, 0], near: 1, far: 10 };
const AMBIENT: AmbientLightSpec = { colour: [1, 1, 1], intensity: 1 };
const KEY: KeyLightSpec = { colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] };
const IBL: IblSpec = { kind: "gradient", top: [1, 1, 1], bottom: [0, 0, 0] };
const OCCLUSION: OcclusionSpec = { mode: "soft", scope: "all" };
const ESTIMATION: ResolvedLightEstimation = { ambient: true, key: true, ibl: false, shadows: false };

function noopHost() {
  return { report: () => {}, estimate: () => {} };
}

describe("NativeEnvironmentPort", () => {
  it("forwards every required slot straight to the host", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);

    port.applySky(SKY);
    port.applyFog(FOG);
    port.applyAmbient(AMBIENT);
    port.applyKeyLight(KEY);
    port.applyIbl(IBL);
    port.applySky(null);
    port.applyFog(null);
    port.applyAmbient(null);
    port.applyKeyLight(null);
    port.applyIbl(null);

    expect(host.applySky).toHaveBeenNthCalledWith(1, SKY);
    expect(host.applySky).toHaveBeenNthCalledWith(2, null);
    expect(host.applyFog).toHaveBeenNthCalledWith(1, FOG);
    expect(host.applyAmbient).toHaveBeenNthCalledWith(1, AMBIENT);
    expect(host.applyKeyLight).toHaveBeenNthCalledWith(1, KEY);
    expect(host.applyIbl).toHaveBeenNthCalledWith(1, IBL);
  });

  it("uses an injected host instead of globalThis.__rcHost", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);
    port.applySky(SKY);
    expect(host.applySky).toHaveBeenCalledWith(SKY);
  });

  it("grows applyOcclusion and applyLightEstimation when the host has them", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);

    expect(port.applyOcclusion).toBeDefined();
    expect(port.applyLightEstimation).toBeDefined();
    port.applyOcclusion?.(OCCLUSION);
    port.applyLightEstimation?.(ESTIMATION);
    expect(host.applyOcclusion).toHaveBeenCalledWith(OCCLUSION);
    expect(host.applyLightEstimation).toHaveBeenCalledWith(ESTIMATION);
  });

  it("omits applyOcclusion when the host has none", () => {
    const host = createFakeEnvironmentHost({ applyOcclusion: false });
    const port = new NativeEnvironmentPort(host);
    expect(port.applyOcclusion).toBeUndefined();
  });

  it("omits applyLightEstimation when the host has none", () => {
    const host = createFakeEnvironmentHost({ applyLightEstimation: false });
    const port = new NativeEnvironmentPort(host);
    expect(port.applyLightEstimation).toBeUndefined();
  });

  it("wires onSensingReport and onLightEstimate to the director's host", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);
    const reports: SensingReport[] = [];
    const estimates: (EstimatedLighting | null)[] = [];
    port.observe({
      report: (report) => reports.push(report),
      estimate: (estimate) => estimates.push(estimate),
    });

    const report: SensingReport = { feature: "occlusion", state: "active" };
    host.emitSensingReport(report);
    host.emitLightEstimate({ ambient: AMBIENT });
    host.emitLightEstimate(null);

    expect(reports).toEqual([report]);
    expect(estimates).toEqual([{ ambient: AMBIENT }, null]);
  });

  it("stops listening once the returned unsubscribe runs", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);
    const reports: SensingReport[] = [];
    const stop = port.observe({ report: (report) => reports.push(report), estimate: () => {} });

    stop();
    host.emitSensingReport({ feature: "occlusion", state: "active" });
    expect(reports).toEqual([]);
  });

  it("wires nothing, and still returns a working unsubscribe, when the host reports neither", () => {
    const host = createFakeEnvironmentHost({ onSensingReport: false, onLightEstimate: false });
    const port = new NativeEnvironmentPort(host);
    const stop = port.observe(noopHost());
    expect(() => stop()).not.toThrow();
  });

  it("dispose unsubscribes observe, and is safe before observe was ever called", () => {
    const host = createFakeEnvironmentHost();
    const port = new NativeEnvironmentPort(host);
    expect(() => port.dispose()).not.toThrow();

    const reports: SensingReport[] = [];
    port.observe({ report: (report) => reports.push(report), estimate: () => {} });
    port.dispose();
    host.emitSensingReport({ feature: "occlusion", state: "active" });
    expect(reports).toEqual([]);
  });
});
