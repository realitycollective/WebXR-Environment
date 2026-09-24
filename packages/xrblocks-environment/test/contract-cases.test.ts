/**
 * Runs the shared port conformance suites from `@realitycollective/webxr-environment`
 * against this adapter's ports, so the promise every platform makes to the
 * core - apply without throwing, report what you can and cannot sense, retire
 * a voice's `ended` exactly once - is checked here rather than assumed.
 *
 * The environment and world-sensing ports are this package's own; the audio
 * path is not - XR Blocks reuses `ThreeAudioPort` outright (see
 * `createXRBlocksAudio`), so the suite runs against what that factory hands
 * back, over the same structural Web Audio context `threejs-environment`
 * tests with (Node has no Web Audio, and jsdom does not implement it either).
 */
import { describe, expect, it } from "vitest";
import { AudioContext, AudioListener, Scene } from "three";
import {
  audioPortContractCases,
  createXRBlocksAudio,
  environmentPortContractCases,
  worldSensingPortContractCases,
  XRBlocksEnvironmentPort,
  XRBlocksWorldSensingPort,
  type AudioPortContractDriver,
} from "@realitycollective/xrblocks-environment";

interface FakeAudioParam {
  value: number;
  setTargetAtTime(value: number): void;
}

interface FakeBufferSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  onended: (() => void) | null;
  playbackRate: FakeAudioParam;
  detune: FakeAudioParam;
  start(): void;
  stop(): void;
  connect(): void;
  disconnect(): void;
}

function param(initial = 0): FakeAudioParam {
  return {
    value: initial,
    setTargetAtTime(value) {
      this.value = value;
    },
  };
}

function fakeContext() {
  const sources: FakeBufferSource[] = [];
  return {
    destination: {},
    currentTime: 0,
    state: "running",
    sources,
    async resume() {
      this.state = "running";
    },
    createGain: () => ({ gain: param(1), connect() {}, disconnect() {} }),
    createPanner: () => ({
      panningModel: "",
      refDistance: 1,
      connect() {},
      disconnect() {},
      positionX: param(),
      positionY: param(),
      positionZ: param(),
      orientationX: param(),
      orientationY: param(),
      orientationZ: param(),
    }),
    createBufferSource(): FakeBufferSource {
      const source: FakeBufferSource = {
        buffer: null,
        loop: false,
        onended: null,
        playbackRate: param(1),
        detune: param(0),
        start() {},
        stop() {},
        connect() {},
        disconnect() {},
      };
      sources.push(source);
      return source;
    },
  };
}

/** A stand-in for a decoded buffer; nothing under test reads its contents. */
function fakeBuffer(): AudioBuffer {
  return { duration: 1, length: 1, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;
}

/** A handful of microtask and one macrotask turn, for the buffer-load promise chain to settle. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("EnvironmentPort contract", () => {
  for (const contractCase of environmentPortContractCases()) {
    it(contractCase.name, () => contractCase.run({ port: new XRBlocksEnvironmentPort(new Scene(), {}) }));
  }
});

describe("AudioPort contract (ThreeAudioPort, via createXRBlocksAudio)", () => {
  function makeSubject(): {
    port: ReturnType<typeof createXRBlocksAudio>["port"];
    driver: AudioPortContractDriver;
  } {
    const context = fakeContext();
    AudioContext.setContext(context as unknown as globalThis.AudioContext);
    const listener = new AudioListener();
    const scene = new Scene();
    scene.add(listener);
    const loader = { loadAsync: async () => fakeBuffer() };
    const { port } = createXRBlocksAudio(listener, { loader, parent: scene });
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
    it(contractCase.name, () => contractCase.run({ port: new XRBlocksWorldSensingPort({}) }));
  }
});

describe("contract suites actually ran", () => {
  it("covers every case, so a suite that shrinks to nothing does not pass silently", () => {
    expect(environmentPortContractCases().length).toBeGreaterThan(0);
    expect(audioPortContractCases().length).toBeGreaterThan(0);
    expect(worldSensingPortContractCases().length).toBeGreaterThan(0);
  });
});
