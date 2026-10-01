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
 *
 * ---------------------------------------------------------------------------
 * A HOLD THAT NEVER LANDS
 * ---------------------------------------------------------------------------
 * A held play resolves when the loader resolves, and a `fetch` that hangs -
 * a dead network, a server that never answers - never does either. That is
 * "never starts" in exactly the sense `AudioStartReaper` exists for (see its
 * file comment), so `start()` tracks every voice with one and `#begin()`
 * (called the instant `play()` is actually invoked, cached buffer or not)
 * confirms it. Only a voice still held when the timeout elapses is ever
 * reaped this way - once `#begin()` has run, the sound plays for however long
 * it plays, exactly as `onended` reports it.
 */
import { Audio, AudioListener, AudioLoader, Object3D, PositionalAudio, Vector3 } from "three";
import type { AudioCue, AudioPort, AudioVoiceRequest } from "@realitycollective/webxr-environment";
import { AudioStartReaper, resolveAudioSpatial } from "@realitycollective/webxr-environment";

export interface ThreeAudioPortOptions {
  /**
   * Where positional voices are parented. Must be in the rendered scene graph
   * or they will not be heard. Default: the listener's own parent, falling
   * back to a detached group (which is a bug the app should fix by passing
   * one).
   */
  readonly parent?: Object3D;
  /**
   * The viewer's head (the render camera). The core rule
   * (`AUDIO_LISTENER_RULE`): the listener is the head, its position and
   * orientation follow the head pose every frame. IWSDK's `AudioSystem`
   * parents its listener to the camera itself; here the port does the same
   * when given the head, moving the listener under it unless it already sits
   * there. Omit only when the app has parented the listener to the camera
   * itself.
   */
  readonly head?: Object3D;
  /** Injected for tests. Defaults to a shared `AudioLoader`. */
  readonly loader?: Pick<AudioLoader, "loadAsync">;
  /** Reference distance for positional voices, metres. Default 1. */
  readonly refDistance?: number;
  /**
   * How long to wait for a held play's buffer before giving up on it,
   * milliseconds. Default 10 000 - see `AudioStartReaper` /
   * `DEFAULT_AUDIO_START_TIMEOUT_MS` in `@realitycollective/webxr-environment`.
   */
  readonly startTimeoutMs?: number;
}

/** Whether `object` is `root` or one of its descendants. */
function isUnder(object: Object3D, root: Object3D): boolean {
  for (let at: Object3D | null = object; at; at = at.parent) {
    if (at === root) return true;
  }
  return false;
}

/** Web Audio points a source along +Z, and three.js follows it. */
const AUDIO_FORWARD = new Vector3(0, 0, 1);
const TEMP_FACING = new Vector3();

/** Radians in the contract; degrees at every host, because Web Audio wants them. */
function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
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
  readonly #reaper: AudioStartReaper;
  readonly #buffers = new Map<string, AudioBuffer>();
  readonly #loading = new Map<string, Promise<AudioBuffer | null>>();
  readonly #voices = new Map<number, ActiveVoice>();
  /** Voices requested while their buffer was still decoding. */
  readonly #waiting = new Set<number>();

  #disposed = false;

  constructor(listener: AudioListener, options: ThreeAudioPortOptions = {}) {
    this.#listener = listener;
    if (options.head && !isUnder(listener, options.head)) options.head.add(listener);
    this.#parent = options.parent ?? listener.parent ?? listener;
    this.#loader = options.loader ?? new AudioLoader();
    this.#refDistance = options.refDistance ?? 1;
    this.#reaper = new AudioStartReaper(
      options.startTimeoutMs === undefined ? {} : { startTimeoutMs: options.startTimeoutMs },
    );
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
    this.#reaper.track(request.voiceId, request, () => this.#onStartTimeout(request));
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
        this.#reaper.release(request.voiceId);
        request.ended();
        return;
      }
      this.#begin(request, loaded);
    });
  }

  stop(voiceId: number): void {
    this.#reaper.release(voiceId);
    if (this.#waiting.delete(voiceId)) return;
    const voice = this.#voices.get(voiceId);
    if (voice === undefined) return;
    this.#voices.delete(voiceId);
    this.#release(voice);
  }

  setGain(voiceId: number, gain: number): void {
    this.#voices.get(voiceId)?.audio.setVolume(gain);
  }

  /** Drives the start-timeout reaper for a voice still held on a buffer that never arrives. */
  update(deltaMs: number): void {
    this.#reaper.update(deltaMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#reaper.clear();
    this.#waiting.clear();
    for (const [id, voice] of this.#voices) {
      this.#voices.delete(id);
      this.#release(voice);
    }
    this.#buffers.clear();
    this.#loading.clear();
  }

  /** The shared reaper gave up on a held voice whose buffer never arrived; see its file comment for the rule. */
  #onStartTimeout(request: AudioVoiceRequest): void {
    if (!this.#waiting.delete(request.voiceId)) return;
    console.warn(`[threejs-environment] cue "${request.cue.id}" never started (${request.cue.src})`);
    request.ended();
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
    // From here on the voice really is starting, cached buffer or a held one
    // that just landed - the reaper's job is done regardless of how long the
    // sound then plays for.
    this.#reaper.confirmStarted(request.voiceId);
    const positional = request.at !== null || (request.cue.positional ?? false);
    let holder: Object3D | null = null;
    let audio: VoiceAudio;

    if (positional) {
      const spatial = new PositionalAudio(this.#listener);
      const voiceHolder = new Object3D();
      // The port's own reference distance is the FLOOR, not the law: a cue
      // that describes how far it carries beats one number applied to every
      // sound in the title, which is what this adapter used to do.
      // Every field arrives resolved from the core defaults (the director's
      // `resolveAudioSpatial`), so the same cue attenuates the same on every
      // platform; the port's own `refDistance` option stands in only for a
      // request built by hand with no attenuation at all.
      const attenuation = request.spatial ?? resolveAudioSpatial({ refDistance: this.#refDistance });
      spatial.setRefDistance(attenuation.refDistance);
      spatial.setRolloffFactor(attenuation.rolloffFactor);
      spatial.setMaxDistance(attenuation.maxDistance);
      spatial.setDistanceModel(attenuation.model);
      // Radians in the contract, degrees at the panner. three.js orients a
      // positional sound along its own +Z, so the holder is turned to point
      // that axis the way the app said the sound travels.
      const cone = attenuation.cone;
      spatial.setDirectionalCone(toDegrees(cone.inner), toDegrees(cone.outer), cone.outsideGain);
      // `?? null` rather than a bare null check: a request built by hand - a
      // test, or an app driving the port directly - carries `undefined` here,
      // and a NaN quaternion is a silent way to lose a sound.
      const towards = request.facing ?? null;
      if (towards !== null) {
        const facing = TEMP_FACING.set(towards[0], towards[1], towards[2]);
        if (facing.lengthSq() > 0) {
          voiceHolder.quaternion.setFromUnitVectors(AUDIO_FORWARD, facing.normalize());
        }
      }
      holder = voiceHolder;
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
