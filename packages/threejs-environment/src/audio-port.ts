/**
 * `AudioPort` for plain three.js, over `AudioListener` / `Audio` /
 * `PositionalAudio` and the Web Audio context behind them.
 *
 * ---------------------------------------------------------------------------
 * THE FIRST PRESS IS NOT SILENT
 * ---------------------------------------------------------------------------
 * The obvious implementation drops a play whose buffer has not decoded yet,
 * and the result is that the first press of every button in a session makes no
 * sound. So a play that arrives early is HELD: the decode is already in
 * flight, and the voice starts when it lands unless it was stopped in the
 * meantime. Late is better than never for a one-shot, and for an ambience bed
 * it is the difference between working and not.
 *
 * ---------------------------------------------------------------------------
 * AUTOPLAY
 * ---------------------------------------------------------------------------
 * Browsers refuse to start an `AudioContext` outside a user gesture, and WebXR
 * entry is a gesture. Call `resume()` from the same handler that enters the
 * session (or from the Enter-VR button) - nothing here can do it for you, and
 * a suspended context makes every voice silently succeed.
 */
import { Audio, AudioListener, AudioLoader, Object3D, PositionalAudio } from "three";
import type { AudioCue, AudioPort, AudioVoiceRequest } from "@realitycollective/webxr-environment";

export interface ThreeAudioPortOptions {
  /**
   * Where positional voices are parented. Must be in the rendered scene graph
   * or they will not be heard. Default: the listener's own parent, falling
   * back to a detached group (which is a bug the app should fix by passing
   * one).
   */
  readonly parent?: Object3D;
  /** Injected for tests. Defaults to a shared `AudioLoader`. */
  readonly loader?: Pick<AudioLoader, "loadAsync">;
  /** Reference distance for positional voices, metres. Default 1. */
  readonly refDistance?: number;
}

/**
 * `Audio` is generic over its output node and `PositionalAudio` fixes it to a
 * panner, so the two do not share a narrower type than this.
 */
type VoiceAudio = Audio<GainNode> | PositionalAudio;

interface ActiveVoice {
  readonly audio: VoiceAudio;
  readonly holder: Object3D | null;
}

export class ThreeAudioPort implements AudioPort {
  readonly #listener: AudioListener;
  readonly #parent: Object3D;
  readonly #loader: Pick<AudioLoader, "loadAsync">;
  readonly #refDistance: number;
  readonly #buffers = new Map<string, AudioBuffer>();
  readonly #loading = new Map<string, Promise<AudioBuffer | null>>();
  readonly #voices = new Map<number, ActiveVoice>();
  /** Voices requested while their buffer was still decoding. */
  readonly #waiting = new Set<number>();

  #disposed = false;

  constructor(listener: AudioListener, options: ThreeAudioPortOptions = {}) {
    this.#listener = listener;
    this.#parent = options.parent ?? listener.parent ?? listener;
    this.#loader = options.loader ?? new AudioLoader();
    this.#refDistance = options.refDistance ?? 1;
  }

  /**
   * Resume the audio context. Call from a user gesture; safe to call twice.
   * Resolves false when there is no context to resume.
   */
  async resume(): Promise<boolean> {
    const context = this.#listener.context as AudioContext | undefined;
    if (context === undefined || typeof context.resume !== "function") return false;
    await context.resume();
    return context.state === "running";
  }

  load(cue: AudioCue): Promise<AudioBuffer | null> {
    return this.#ensureLoaded(cue);
  }

  start(request: AudioVoiceRequest): void {
    if (this.#disposed) {
      request.ended();
      return;
    }
    const buffer = this.#buffers.get(request.cue.id);
    if (buffer !== undefined) {
      this.#begin(request, buffer);
      return;
    }
    this.#waiting.add(request.voiceId);
    void this.#ensureLoaded(request.cue).then((loaded) => {
      // `stop` removes the id, so a voice cancelled during the decode never
      // starts. This is also the disposal path.
      if (!this.#waiting.delete(request.voiceId) || this.#disposed) return;
      if (loaded === null) {
        request.ended();
        return;
      }
      this.#begin(request, loaded);
    });
  }

  stop(voiceId: number): void {
    if (this.#waiting.delete(voiceId)) return;
    const voice = this.#voices.get(voiceId);
    if (voice === undefined) return;
    this.#voices.delete(voiceId);
    this.#release(voice);
  }

  setGain(voiceId: number, gain: number): void {
    this.#voices.get(voiceId)?.audio.setVolume(gain);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#waiting.clear();
    for (const [id, voice] of this.#voices) {
      this.#voices.delete(id);
      this.#release(voice);
    }
    this.#buffers.clear();
    this.#loading.clear();
  }

  #ensureLoaded(cue: AudioCue): Promise<AudioBuffer | null> {
    const ready = this.#buffers.get(cue.id);
    if (ready !== undefined) return Promise.resolve(ready);
    const inFlight = this.#loading.get(cue.id);
    if (inFlight !== undefined) return inFlight;

    const pending = this.#loader
      .loadAsync(cue.src)
      .then((buffer: AudioBuffer) => {
        this.#buffers.set(cue.id, buffer);
        return buffer;
      })
      .catch((error: unknown) => {
        // A missing sound must not take gameplay down. Report it once - the
        // entry stays out of `#buffers`, so a later play retries the fetch.
        console.warn(`[threejs-environment] could not load cue "${cue.id}" (${cue.src})`, error);
        return null;
      })
      .finally(() => {
        this.#loading.delete(cue.id);
      });
    this.#loading.set(cue.id, pending);
    return pending;
  }

  #begin(request: AudioVoiceRequest, buffer: AudioBuffer): void {
    const positional = request.at !== null || (request.cue.positional ?? false);
    let holder: Object3D | null = null;
    let audio: VoiceAudio;

    if (positional) {
      const spatial = new PositionalAudio(this.#listener);
      spatial.setRefDistance(this.#refDistance);
      holder = new Object3D();
      holder.name = `webxr-environment:voice-${request.voiceId}`;
      if (request.at !== null) holder.position.set(request.at[0], request.at[1], request.at[2]);
      holder.add(spatial);
      this.#parent.add(holder);
      audio = spatial;
    } else {
      // Explicit type argument: the assignment target is a union, and TypeScript
      // would otherwise infer `Audio<GainNode | PannerNode>` from it.
      audio = new Audio<GainNode>(this.#listener);
    }

    audio.setBuffer(buffer);
    audio.setLoop(request.loop);
    audio.setVolume(request.gain);

    const voice: ActiveVoice = { audio, holder };
    this.#voices.set(request.voiceId, voice);

    // three.js binds `onEnded` at `play()` time, so wrapping it here keeps its
    // own `isPlaying` bookkeeping and adds ours on top. A looping voice never
    // reaches this, which is correct - it ends when someone stops it.
    const inherited = audio.onEnded.bind(audio);
    audio.onEnded = () => {
      inherited();
      if (this.#voices.get(request.voiceId) !== voice) return;
      this.#voices.delete(request.voiceId);
      this.#detach(voice);
      request.ended();
    };

    audio.play();
  }

  #release(voice: ActiveVoice): void {
    if (voice.audio.isPlaying) voice.audio.stop();
    this.#detach(voice);
  }

  #detach(voice: ActiveVoice): void {
    voice.audio.disconnect();
    voice.audio.removeFromParent();
    voice.holder?.removeFromParent();
  }
}
