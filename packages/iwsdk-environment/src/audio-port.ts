/**
 * `AudioPort` for Meta IWSDK, over `AudioSource` + `AudioUtils`.
 *
 * ---------------------------------------------------------------------------
 * ONE ENTITY PER VOICE
 * ---------------------------------------------------------------------------
 * IWSDK's audio is a component on an entity, with its own pooling and its own
 * retrigger policy per source. Reusing one entity per CUE would hand those
 * decisions back to IWSDK and make `restart` and `ignore` mean something
 * different here than on three.js, which is the divergence this stack exists
 * to remove. So a voice is an entity: the director's policy wins, every voice
 * is individually stoppable, and IWSDK's own `playbackMode` is pinned to
 * `Overlap` so it never second-guesses the core.
 *
 * ---------------------------------------------------------------------------
 * KNOWING WHEN A SOUND FINISHED
 * ---------------------------------------------------------------------------
 * IWSDK reports whether a source IS playing, never that it has just stopped.
 * So this port polls in `update()` - which the director already calls - and
 * reports the end once a voice has been observed playing and then is not.
 * A voice that never starts at all (a missing file, a decode failure) would
 * otherwise be tracked forever, so it is reaped after `startTimeoutMs`.
 */
import { AudioSource, AudioUtils, PlaybackMode, Transform, type Entity, type World } from "@iwsdk/core";
import type { AudioPort, AudioVoiceRequest } from "@realitycollective/webxr-environment";

export interface IWSDKAudioPortOptions {
  /** Parent for the voice entities. Defaults to the world's default parent. */
  readonly parent?: Entity;
  /**
   * How long to wait for a voice to start before giving up on it,
   * milliseconds. Default 10 000 - generous, because a cold asset fetch on a
   * headset over hotel wifi is slower than anyone's patience.
   */
  readonly startTimeoutMs?: number;
}

interface Voice {
  readonly entity: Entity;
  readonly request: AudioVoiceRequest;
  started: boolean;
  waitedMs: number;
}

export class IWSDKAudioPort implements AudioPort {
  readonly #world: World;
  readonly #parent: Entity | undefined;
  readonly #startTimeoutMs: number;
  readonly #voices = new Map<number, Voice>();

  #disposed = false;

  constructor(world: World, options: IWSDKAudioPortOptions = {}) {
    this.#world = world;
    this.#parent = options.parent;
    this.#startTimeoutMs = options.startTimeoutMs ?? 10_000;
  }

  start(request: AudioVoiceRequest): void {
    if (this.#disposed) {
      request.ended();
      return;
    }
    const entity = this.#world.createTransformEntity(
      undefined,
      this.#parent === undefined ? undefined : { parent: this.#parent },
    );
    const positional = request.at !== null || (request.cue.positional ?? false);
    if (request.at !== null) {
      const view = entity.getVectorView(Transform, "position");
      view[0] = request.at[0];
      view[1] = request.at[1];
      view[2] = request.at[2];
    }
    entity.addComponent(AudioSource, {
      src: request.cue.src,
      volume: request.gain,
      loop: request.loop,
      positional,
      autoplay: false,
      // The core already applied the cue's policy before we got here.
      playbackMode: PlaybackMode.Overlap,
    });
    this.#voices.set(request.voiceId, { entity, request, started: false, waitedMs: 0 });
    AudioUtils.play(entity);
  }

  stop(voiceId: number): void {
    const voice = this.#voices.get(voiceId);
    if (voice === undefined) return;
    this.#voices.delete(voiceId);
    this.#retire(voice);
  }

  setGain(voiceId: number, gain: number): void {
    const voice = this.#voices.get(voiceId);
    if (voice === undefined) return;
    AudioUtils.setVolume(voice.entity, gain);
  }

  update(deltaMs: number): void {
    if (this.#disposed || this.#voices.size === 0) return;
    for (const [id, voice] of [...this.#voices]) {
      // A looping voice ends when someone stops it, never on its own.
      if (voice.request.loop) continue;
      const playing = AudioUtils.isPlaying(voice.entity);
      if (playing) {
        voice.started = true;
        continue;
      }
      if (!voice.started) {
        voice.waitedMs += deltaMs;
        if (voice.waitedMs < this.#startTimeoutMs) continue;
        console.warn(
          `[iwsdk-environment] cue "${voice.request.cue.id}" never started (${voice.request.cue.src})`,
        );
      }
      this.#voices.delete(id);
      this.#retire(voice);
      voice.request.ended();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [id, voice] of [...this.#voices]) {
      this.#voices.delete(id);
      this.#retire(voice);
    }
  }

  #retire(voice: Voice): void {
    AudioUtils.stop(voice.entity);
    voice.entity.destroy();
  }
}
