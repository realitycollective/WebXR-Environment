/**
 * Runs the shared port conformance suites from `@realitycollective/webxr-environment`
 * against this adapter's three ports, so the promise every platform makes to
 * the core - apply without throwing, report what you can and cannot sense,
 * retire a voice's `ended` exactly once - is checked here rather than assumed.
 *
 * This adapter only forwards or omits, and never decides - reporting a
 * sensor-backed feature is entirely the NATIVE host's job (see
 * `environment-port.ts`'s file comment). So the fakes here are built to be a
 * conforming host: one that answers `applyOcclusion` / `applyLightEstimation`
 * / `setDetection` / `startHitTest` by calling back exactly as a real Swift or
 * Kotlin host would, which is the half of the contract this package cannot
 * prove on its own.
 */
import { describe, expect, it, vi } from "vitest";
import {
  audioPortContractCases,
  environmentPortContractCases,
  worldSensingPortContractCases,
  NativeAudioPort,
  NativeEnvironmentPort,
  NativeWorldSensingPort,
  type AudioPortContractDriver,
} from "@realitycollective/native-environment";
import {
  createFakeAudioHost,
  createFakeEnvironmentHost,
  createFakeSensingHost,
} from "./helpers.js";

/** A host that reports back exactly as a real native implementation would. */
function conformingEnvironmentHost() {
  const host = createFakeEnvironmentHost();
  host.applyOcclusion = vi.fn((spec) => {
    host.emitSensingReport(
      spec === null ? { feature: "occlusion", state: "unavailable" } : { feature: "occlusion", state: "active" },
    );
  });
  host.applyLightEstimation = vi.fn((estimation) => {
    host.emitSensingReport(
      estimation === null
        ? { feature: "lightEstimation", state: "unavailable" }
        : { feature: "lightEstimation", state: "active" },
    );
  });
  return host;
}

/** Likewise for world sensing: a real host answers a request, this fake does too. */
function conformingSensingHost() {
  const host = createFakeSensingHost();
  host.setDetection = vi.fn((detection) => {
    if (detection?.planes) host.emitSensingReport({ feature: "planes", state: "active" });
  });
  host.startHitTest = vi.fn(() => {
    host.emitSensingReport({ feature: "hitTest", state: "pending" });
  });
  return host;
}

describe("EnvironmentPort contract", () => {
  for (const contractCase of environmentPortContractCases()) {
    it(contractCase.name, () =>
      contractCase.run({ port: new NativeEnvironmentPort(conformingEnvironmentHost()) }),
    );
  }
});

describe("AudioPort contract", () => {
  function makeSubject(): { port: NativeAudioPort; driver: AudioPortContractDriver } {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    const driver: AudioPortContractDriver = {
      // The native host pushes the end of a voice through onVoiceEnded; a
      // stopped voice is untracked first, so driving one the port already
      // forgot is correctly a no-op rather than a second `ended`.
      end(voiceId) {
        host.emitVoiceEnded(voiceId);
      },
    };
    return { port, driver };
  }

  for (const contractCase of audioPortContractCases()) {
    it(contractCase.name, () => contractCase.run(makeSubject()));
  }
});

describe("WorldSensingPort contract", () => {
  for (const contractCase of worldSensingPortContractCases()) {
    it(contractCase.name, () =>
      contractCase.run({ port: new NativeWorldSensingPort(conformingSensingHost()) }),
    );
  }
});

describe("contract suites actually ran", () => {
  it("covers every case, so a suite that shrinks to nothing does not pass silently", () => {
    expect(environmentPortContractCases().length).toBeGreaterThan(0);
    expect(audioPortContractCases().length).toBeGreaterThan(0);
    expect(worldSensingPortContractCases().length).toBeGreaterThan(0);
  });
});
