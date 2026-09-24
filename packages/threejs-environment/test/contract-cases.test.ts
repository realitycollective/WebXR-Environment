/**
 * Runs the shared port conformance suites from `@realitycollective/webxr-environment`
 * against this adapter's three ports, so the promise every platform makes to
 * the core - apply without throwing, report what you can and cannot sense,
 * retire a voice's `ended` exactly once - is checked here rather than assumed.
 */
import { describe, expect, it } from "vitest";
import { Scene } from "three";
import {
  audioPortContractCases,
  environmentPortContractCases,
  worldSensingPortContractCases,
  ThreeAudioPort,
  ThreeEnvironmentPort,
  ThreeWorldSensingPort,
  type AudioPortContractDriver,
  type XrRendererLike,
} from "@realitycollective/threejs-environment";
import { createTestListener, fakeBuffer } from "./helpers.js";

/** No session at all: every sensor-backed feature answers "unavailable" or "unsupported". */
const NO_SESSION_RENDERER: XrRendererLike = { xr: { getSession: () => null } };

/** A handful of microtask and one macrotask turn, for the buffer-load promise chain to settle. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("EnvironmentPort contract", () => {
  for (const contractCase of environmentPortContractCases()) {
    it(contractCase.name, () => contractCase.run({ port: new ThreeEnvironmentPort(new Scene()) }));
  }
});

describe("AudioPort contract", () => {
  function makeSubject(): { port: ThreeAudioPort; driver: AudioPortContractDriver } {
    const { listener, context } = createTestListener();
    const scene = new Scene();
    scene.add(listener);
    const loader = { loadAsync: async () => fakeBuffer() };
    const port = new ThreeAudioPort(listener, { loader, parent: scene });
    const driver: AudioPortContractDriver = {
      async end() {
        // A voice already cancelled by stop() while its buffer was still
        // decoding never creates a source; there is then nothing to end,
        // which is the correct outcome and not a reason to wait forever.
        await flush();
        context.sources.at(-1)?.onended?.();
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
      contractCase.run({ port: new ThreeWorldSensingPort(NO_SESSION_RENDERER) }),
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
