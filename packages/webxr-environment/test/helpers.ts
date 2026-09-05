/**
 * Recording ports. Every core test drives a director against one of these, so
 * "what did the adapter actually get told" is an assertion rather than a
 * guess.
 */
import type {
  AmbientLightSpec,
  AudioPort,
  AudioVoiceRequest,
  EnvironmentPort,
  FogSpec,
  KeyLightSpec,
  SkySpec,
} from "@realitycollective/webxr-environment";

export type EnvironmentCall =
  | { readonly slot: "sky"; readonly value: SkySpec | null }
  | { readonly slot: "fog"; readonly value: FogSpec | null }
  | { readonly slot: "ambient"; readonly value: AmbientLightSpec | null }
  | { readonly slot: "key"; readonly value: KeyLightSpec | null };

export class RecordingEnvironmentPort implements EnvironmentPort {
  readonly calls: EnvironmentCall[] = [];
  disposed = false;

  applySky(value: SkySpec | null): void {
    this.calls.push({ slot: "sky", value });
  }
  applyFog(value: FogSpec | null): void {
    this.calls.push({ slot: "fog", value });
  }
  applyAmbient(value: AmbientLightSpec | null): void {
    this.calls.push({ slot: "ambient", value });
  }
  applyKeyLight(value: KeyLightSpec | null): void {
    this.calls.push({ slot: "key", value });
  }
  dispose(): void {
    this.disposed = true;
  }

  /** Every call for one slot, oldest first. */
  forSlot<S extends EnvironmentCall["slot"]>(slot: S): EnvironmentCall[] {
    return this.calls.filter((call) => call.slot === slot);
  }

  /** The most recent value pushed for a slot. */
  last(slot: EnvironmentCall["slot"]): EnvironmentCall["value"] | undefined {
    return this.forSlot(slot).at(-1)?.value;
  }

  clear(): void {
    this.calls.length = 0;
  }
}

export interface StartedVoice {
  readonly request: AudioVoiceRequest;
  gain: number;
}

/**
 * An audio port that behaves like a real one: voices stay alive until stopped
 * or explicitly ended. `finish()` is the test's stand-in for "the sound ran
 * out", which is the event a real port reports from its engine.
 */
export class RecordingAudioPort implements AudioPort {
  readonly loaded: string[] = [];
  readonly started: StartedVoice[] = [];
  readonly stopped: number[] = [];
  readonly updates: number[] = [];
  disposed = false;

  /** When set, `start` reports the voice ended immediately - fire and forget. */
  fireAndForget = false;

  load(cue: { id: string }): void {
    this.loaded.push(cue.id);
  }

  start(request: AudioVoiceRequest): void {
    this.started.push({ request, gain: request.gain });
    if (this.fireAndForget) request.ended();
  }

  stop(voiceId: number): void {
    this.stopped.push(voiceId);
  }

  setGain(voiceId: number, gain: number): void {
    const voice = this.started.find((entry) => entry.request.voiceId === voiceId);
    if (voice !== undefined) voice.gain = gain;
  }

  update(deltaMs: number): void {
    this.updates.push(deltaMs);
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Report that a voice finished on its own. */
  finish(voiceId: number): void {
    this.started.find((entry) => entry.request.voiceId === voiceId)?.request.ended();
  }

  voice(voiceId: number): StartedVoice | undefined {
    return this.started.find((entry) => entry.request.voiceId === voiceId);
  }
}

/** A port with only the required members, to prove the optional ones are optional. */
export class MinimalAudioPort implements AudioPort {
  readonly started: AudioVoiceRequest[] = [];
  readonly stopped: number[] = [];

  start(request: AudioVoiceRequest): void {
    this.started.push(request);
  }
  stop(voiceId: number): void {
    this.stopped.push(voiceId);
  }
}

/** Likewise for the environment: no `dispose`. */
export class MinimalEnvironmentPort implements EnvironmentPort {
  skies = 0;
  applySky(): void {
    this.skies += 1;
  }
  applyFog(): void {}
  applyAmbient(): void {}
  applyKeyLight(): void {}
}

/** A controllable clock for the throttle tests. */
export function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
