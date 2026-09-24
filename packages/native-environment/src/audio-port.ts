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
 */
import type { AudioPort, AudioVoiceRequest } from "@realitycollective/webxr-environment";
import type { AudioCue } from "@realitycollective/webxr-environment";
import type { NativeAudioHost } from "./native-types.js";
import { getAudioHost } from "./native-types.js";

export class NativeAudioPort implements AudioPort {
  readonly #host: NativeAudioHost;
  readonly #ended = new Map<number, () => void>();
  #unsubscribe: (() => void) | undefined;
  #disposed = false;

  constructor(host?: NativeAudioHost) {
    this.#host = getAudioHost(host);
    this.#unsubscribe = this.#host.onVoiceEnded((voiceId) => {
      const ended = this.#ended.get(voiceId);
      if (ended === undefined) return;
      this.#ended.delete(voiceId);
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
    this.#host.start({ voiceId, cue, gain, loop, at, spatial, facing });
  }

  stop(voiceId: number): void {
    if (!this.#ended.delete(voiceId)) return;
    this.#host.stop(voiceId);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#ended.clear();
  }
}
