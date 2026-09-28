/**
 * `AudioPort` for a native host.
 *
 * ---------------------------------------------------------------------------
 * WHY `ended` NEVER CROSSES
 * ---------------------------------------------------------------------------
 * `AudioVoiceRequest.ended` is a callback the CORE hands to a port so the port
 * can tell it a voice is done. That is backwards from every other function
 * that crosses this boundary - the rule is "the only functions that cross are
 * listener callbacks passed to an `on*` method", and `ended` is neither. So it
 * never reaches the host at all: this port keeps every voice's `ended`,
 * keyed by `voiceId`, in a plain `Map`, sends the host a request with that one
 * member removed (`NativeAudioVoiceRequest`), and runs the callback itself
 * when `NativeAudioHost.onVoiceEnded` names that id.
 *
 * ---------------------------------------------------------------------------
 * THE BOOKKEEPING THAT KEEPS `stop` HONEST
 * ---------------------------------------------------------------------------
 * `AudioPort.stop`'s own comment says it is "called at most once per voice,
 * never after `ended`". The director is expected to hold to that, but a voice
 * ending and a voice being stopped can race - a host might report
 * `onVoiceEnded` for an id in the same tick something upstream decided to stop
 * it - so the map is also the guard: `ended` is removed the instant it runs,
 * and `stop` does nothing for an id that is not in the map any more, rather
 * than forwarding a second message about a voice the host has already
 * forgotten.
 *
 * ---------------------------------------------------------------------------
 * A VOICE THE HOST NEVER MENTIONS AGAIN
 * ---------------------------------------------------------------------------
 * `onVoiceEnded` is the ONLY signal this port ever gets about a voice, so a
 * host that fails to start one and forgets to report it leaves that voice
 * invisible - there is no separate "it started" message to notice the absence
 * of. This port therefore composes an `AudioStartReaper` (see its file
 * comment) as a backstop: every non-looping voice with no declared
 * `durationMs` is watched, and one still unreported past `startTimeoutMs` is
 * released locally, exactly as if the host had called `onVoiceEnded` for it.
 * A real host should still report a failed start promptly and is expected to
 * (see `NativeAudioHost.onVoiceEnded`); this is what stands between that
 * expectation and a permanent leak when a host does not. A cue that
 * legitimately plays longer than `startTimeoutMs` should declare its own
 * `durationMs` so it is never mistaken for one that never started.
 */
import type { AudioPort, AudioVoiceRequest } from "@realitycollective/webxr-environment";
import type { AudioCue } from "@realitycollective/webxr-environment";
import { AudioStartReaper } from "@realitycollective/webxr-environment";
import type { NativeAudioHost } from "./native-types.js";
import { getAudioHost } from "./native-types.js";

export interface NativeAudioPortOptions {
  /**
   * How long to wait for the host to report a voice as started or ended
   * before releasing it locally, milliseconds. Default 10 000 - see
   * `AudioStartReaper` / `DEFAULT_AUDIO_START_TIMEOUT_MS` in
   * `@realitycollective/webxr-environment`.
   */
  readonly startTimeoutMs?: number;
}

export class NativeAudioPort implements AudioPort {
  readonly #host: NativeAudioHost;
  readonly #ended = new Map<number, () => void>();
  readonly #reaper: AudioStartReaper;
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(host?: NativeAudioHost, options: NativeAudioPortOptions = {}) {
    this.#host = getAudioHost(host);
    this.#reaper = new AudioStartReaper(
      options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs },
    );
    this.#unsubscribe = this.#host.onVoiceEnded((voiceId) => {
      const ended = this.#ended.get(voiceId);
      if (ended === undefined) return;
      this.#ended.delete(voiceId);
      this.#reaper.release(voiceId);
      ended();
    });
    if (this.#host.load !== undefined) {
      const load = this.#host.load;
      this.load = (cue: AudioCue) => load(cue);
    }
    if (this.#host.setGain !== undefined) {
      const setGain = this.#host.setGain;
      this.setGain = (voiceId: number, gain: number) => setGain(voiceId, gain);
    }
  }

  /** Present only when the host implements `load`. */
  load?: (cue: AudioCue) => void | Promise<unknown>;

  /** Present only when the host implements `setGain`. */
  setGain?: (voiceId: number, gain: number) => void;

  start(request: AudioVoiceRequest): void {
    if (this.#disposed) {
      request.ended();
      return;
    }
    const { voiceId, cue, gain, loop, at, spatial, facing } = request;
    this.#ended.set(voiceId, request.ended);
    // The host never signals a start, only an end (see the file comment), so
    // this is never confirmed here - the reaper is the only thing that can
    // release this voice besides the host itself.
    this.#reaper.track(voiceId, request, () => this.#onStartTimeout(voiceId));
    this.#host.start({ voiceId, cue, gain, loop, at, spatial, facing });
  }

  stop(voiceId: number): void {
    if (!this.#ended.delete(voiceId)) return;
    this.#reaper.release(voiceId);
    this.#host.stop(voiceId);
  }

  /** Drives the start-timeout reaper for a voice the host has not yet reported on. */
  update(deltaMs: number): void {
    this.#reaper.update(deltaMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reaper.clear();
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#ended.clear();
  }

  /** The shared reaper gave up on a voice the host never reported on; see its file comment for the rule. */
  #onStartTimeout(voiceId: number): void {
    const ended = this.#ended.get(voiceId);
    if (ended === undefined) return;
    this.#ended.delete(voiceId);
    console.warn(
      `[native-environment] voice ${voiceId} was never reported started or ended by the host within the start timeout`,
    );
    // Tell the host to give up too, in case it eventually does start - a late
    // `onVoiceEnded` for this id then finds nothing in `#ended` and is
    // correctly a no-op (see the file comment).
    this.#host.stop(voiceId);
    ended();
  }
}
