/**
 * Runs the shared port conformance suites from `@realitycollective/webxr-environment`
 * against this adapter's three ports, so the promise every platform makes to
 * the core - apply without throwing, report what you can and cannot sense,
 * retire a voice's `ended` exactly once - is checked here rather than assumed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioUtils, type Entity } from "@iwsdk/core";
import {
  audioPortContractCases,
  environmentPortContractCases,
  worldSensingPortContractCases,
  IWSDKAudioPort,
  IWSDKEnvironmentPort,
  IWSDKWorldSensingPort,
  type AudioPortContractDriver,
} from "@realitycollective/iwsdk-environment";
import { asWorld, createFakeWorld, type FakeWorld } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EnvironmentPort contract", () => {
  for (const contractCase of environmentPortContractCases()) {
    it(contractCase.name, () =>
      contractCase.run({ port: new IWSDKEnvironmentPort(asWorld(createFakeWorld())) }),
    );
  }
});

describe("AudioPort contract", () => {
  const idOf = (entity: Entity) => (entity as unknown as { id: number }).id;

  function makeSubject(): { port: IWSDKAudioPort; driver: AudioPortContractDriver } {
    const playing = new Set<number>();
    vi.spyOn(AudioUtils, "play").mockImplementation(() => {});
    vi.spyOn(AudioUtils, "stop").mockImplementation(() => {});
    vi.spyOn(AudioUtils, "setVolume").mockImplementation(() => {});
    vi.spyOn(AudioUtils, "isPlaying").mockImplementation((entity) => playing.has(idOf(entity)));

    const world: FakeWorld = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));
    const driver: AudioPortContractDriver = {
      end() {
        // IWSDK never pushes an end; this port polls `AudioUtils.isPlaying` in
        // `update()`, so driving one means saying the entity played and then
        // stopped, exactly what a real IWSDK source reports across two frames.
        const entity = world.created.at(-1);
        if (entity === undefined) return;
        const id = idOf(entity as unknown as Entity);
        playing.add(id);
        port.update(16);
        playing.delete(id);
        port.update(16);
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
      contractCase.run({ port: new IWSDKWorldSensingPort(asWorld(createFakeWorld())) }),
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
