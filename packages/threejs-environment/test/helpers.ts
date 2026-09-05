/**
 * A structural Web Audio context, and the three.js listener built on it.
 *
 * Node has no Web Audio and jsdom does not implement it either, so the choice
 * is between mocking the three.js audio classes - which would test the mock -
 * and supplying the handful of nodes those classes actually touch, which tests
 * the real `Audio`, `PositionalAudio` and `AudioListener`. This is the second.
 *
 * `setTargetAtTime` writes `value` immediately here. A real ramp would make
 * every gain assertion a race, and what is under test is which value the port
 * asked for, not how the browser glides to it.
 */
import { AudioContext, AudioListener } from "three";

export interface FakeAudioParam {
  value: number;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
}

export interface FakeGainNode {
  readonly gain: FakeAudioParam;
  connect(target: unknown): void;
  disconnect(target?: unknown): void;
}

export interface FakeBufferSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onended: (() => void) | null;
  playbackRate: FakeAudioParam;
  detune: FakeAudioParam;
  started: boolean;
  stopped: boolean;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  connect(target: unknown): void;
  disconnect(target?: unknown): void;
}

function param(initial = 0): FakeAudioParam {
  return {
    value: initial,
    setTargetAtTime(value) {
      this.value = value;
    },
  };
}

function gainNode(): FakeGainNode {
  return { gain: param(1), connect() {}, disconnect() {} };
}

export interface FakeAudioContext {
  readonly destination: object;
  currentTime: number;
  state: string;
  readonly sources: FakeBufferSource[];
  /** Every gain node handed out, in creation order. Index 0 is the listener's. */
  readonly gains: FakeGainNode[];
  resume(): Promise<void>;
  createGain(): FakeGainNode;
  createPanner(): Record<string, unknown>;
  createBufferSource(): FakeBufferSource;
}

export function createFakeAudioContext(): FakeAudioContext {
  const sources: FakeBufferSource[] = [];
  const gains: FakeGainNode[] = [];
  return {
    destination: {},
    currentTime: 0,
    state: "suspended",
    sources,
    gains,
    async resume() {
      this.state = "running";
    },
    createGain() {
      const node = gainNode();
      gains.push(node);
      return node;
    },
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
    createBufferSource() {
      const source: FakeBufferSource = {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        onended: null,
        playbackRate: param(1),
        detune: param(0),
        started: false,
        stopped: false,
        start() {
          this.started = true;
        },
        stop() {
          this.stopped = true;
        },
        connect() {},
        disconnect() {},
      };
      sources.push(source);
      return source;
    },
  };
}

/** Install a fake context and hand back a real three.js listener on it. */
export function createTestListener(): {
  listener: AudioListener;
  context: FakeAudioContext;
} {
  const context = createFakeAudioContext();
  AudioContext.setContext(context as unknown as globalThis.AudioContext);
  return { listener: new AudioListener(), context };
}

/** A stand-in for a decoded buffer; nothing under test reads its contents. */
export function fakeBuffer(): AudioBuffer {
  return { duration: 1, length: 1, numberOfChannels: 1, sampleRate: 48_000 } as AudioBuffer;
}
