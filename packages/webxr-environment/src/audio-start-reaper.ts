/**
 * The audio start-timeout reaper: the rule that a voice a port started but
 * never confirmed as playing gets released, so it cannot leak forever.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS RULE CAME FROM
 * ---------------------------------------------------------------------------
 * IWSDK reports whether a source IS playing, never that it has just stopped,
 * and it never reports a failure to start at all - a missing file or a decode
 * error just leaves a source silently not-playing forever. `iwsdk-environment`
 * used to poll for that itself and give up after a fixed wait. That is not an
 * IWSDK quirk, it is the general shape of "a voice that never starts": three.js
 * has it too (a buffer fetch that never resolves), and a native host has it
 * worst of all, since the only way JavaScript hears about a voice at all is
 * `onVoiceEnded` - if the host fails to start one and forgets to say so, that
 * voice is invisible forever. So the rule lives here, once, and every
 * `AudioPort` composes one instance of it rather than inventing its own timer.
 *
 * ---------------------------------------------------------------------------
 * WHAT "STARTED" MEANS
 * ---------------------------------------------------------------------------
 * A port calls {@link AudioStartReaper.track} the moment it issues a voice,
 * {@link AudioStartReaper.confirmStarted} the moment it can be sure the voice
 * is actually making noise, and {@link AudioStartReaper.release} the moment
 * the voice ends for any other reason - a natural end, an explicit `stop()`,
 * or (for `iwsdk-environment`) the same poll that already tracked playback.
 * A port with no way to confirm the moment - a native host that reports only
 * `onVoiceEnded`, never a start - simply never calls `confirmStarted`, and
 * this reaper is then the ONLY thing standing between a voice the host
 * silently dropped and a leak. Give a cue that legitimately runs longer than
 * `startTimeoutMs` its own `durationMs` (see `AudioCue.durationMs`) so it is
 * never mistaken for one that never started - see the exemption below.
 *
 * ---------------------------------------------------------------------------
 * WHAT NEVER GETS REAPED
 * ---------------------------------------------------------------------------
 * A LOOPING voice is never tracked at all: a loop ends only when told to,
 * exactly as IWSDK's original reaper skipped one outright, and judging it by
 * how long it took to begin would end a sound the app asked to run until
 * stopped. A voice whose cue names its own `durationMs` is exempt for the
 * same reason coming from the other direction: the app has already declared
 * how long it runs, `AudioDirector.update` already retires it on that
 * schedule, and a port with no start signal (native, without host support)
 * would otherwise time out a cue that is simply longer than
 * `startTimeoutMs` and still playing correctly.
 */
import type { AudioVoiceRequest } from "./audio.js";

/**
 * Milliseconds a port may wait for a voice to start before {@link AudioStartReaper}
 * gives up on it. IWSDK's own original default - generous, because a cold
 * asset fetch on a headset over hotel wifi is slower than anyone's patience -
 * carried here as the one value every platform now shares.
 */
export const DEFAULT_AUDIO_START_TIMEOUT_MS = 10_000;

export interface AudioStartReaperOptions {
  /** See {@link DEFAULT_AUDIO_START_TIMEOUT_MS}. */
  readonly startTimeoutMs?: number;
}

interface TrackedVoice {
  readonly onTimeout: () => void;
  waitedMs: number;
}

/** The parts of a request the reaper needs to decide whether to track a voice at all. */
export type AudioStartReaperRequest = Pick<AudioVoiceRequest, "loop"> & {
  readonly cue: Pick<AudioVoiceRequest["cue"], "durationMs">;
};

/**
 * Tracks voices a port has started but not yet confirmed as playing, and
 * calls back once each has waited past `startTimeoutMs`. Engine-free: it
 * knows nothing about any particular platform's engine, only about elapsed
 * milliseconds, so every `AudioPort` implementation can compose one instance
 * of it and drive it from its own `update`.
 *
 * See the file comment for the exact rule - what "started" means, and the two
 * cases (a loop, a cue with its own `durationMs`) that are never tracked.
 */
export class AudioStartReaper {
  readonly #startTimeoutMs: number;
  readonly #tracked = new Map<number, TrackedVoice>();

  constructor(options: AudioStartReaperOptions = {}) {
    this.#startTimeoutMs = options.startTimeoutMs ?? DEFAULT_AUDIO_START_TIMEOUT_MS;
  }

  /** The timeout this instance was constructed with. */
  get startTimeoutMs(): number {
    return this.#startTimeoutMs;
  }

  /**
   * Start watching a voice. A looping request, or one whose cue declares its
   * own `durationMs`, is never tracked - see the file comment - so `track` is
   * safe to call unconditionally from `AudioPort.start` for every voice.
   */
  track(voiceId: number, request: AudioStartReaperRequest, onTimeout: () => void): void {
    if (request.loop || request.cue.durationMs !== undefined) return;
    this.#tracked.set(voiceId, { onTimeout, waitedMs: 0 });
  }

  /** The port is now sure this voice is actually playing; stop watching it. */
  confirmStarted(voiceId: number): void {
    this.#tracked.delete(voiceId);
  }

  /** The voice ended some other way - naturally, or by an explicit stop; stop watching it. */
  release(voiceId: number): void {
    this.#tracked.delete(voiceId);
  }

  /**
   * Advance every tracked voice's clock by `deltaMs`. A voice still
   * unconfirmed once it reaches `startTimeoutMs` is dropped from tracking and
   * its `onTimeout` runs exactly once. Drive this from the port's own
   * `AudioPort.update`.
   */
  update(deltaMs: number): void {
    if (this.#tracked.size === 0) return;
    for (const [voiceId, voice] of [...this.#tracked]) {
      voice.waitedMs += deltaMs;
      if (voice.waitedMs < this.#startTimeoutMs) continue;
      this.#tracked.delete(voiceId);
      voice.onTimeout();
    }
  }

  /** Stop watching every voice, without calling anything back. For `dispose()`. */
  clear(): void {
    this.#tracked.clear();
  }
}
