/**
 * The two ports an engine adapter implements. Nothing else in this package is
 * engine facing, and nothing in this file has an implementation - that is the
 * seam.
 *
 * Both are written so that an adapter is a translator and never a decision
 * maker: the core has already resolved the interpolation, the mix and the
 * retrigger policy by the time a port method is called.
 */
import type {
  AmbientLightSpec,
  FogSpec,
  IblSpec,
  KeyLightSpec,
  SkySpec,
} from "./environment.js";
import type { AudioCue, AudioVoiceRequest } from "./audio.js";
import type { OcclusionSpec } from "./occlusion.js";
import type { ResolvedLightEstimation } from "./light-estimation.js";
import type { EnvironmentPortHost } from "./sensing.js";

/**
 * Applies an environment to a scene.
 *
 * Every method takes the whole slot, or `null` to remove it. The director
 * calls a method ONLY when that slot's value actually changed, so an adapter
 * may treat each call as "this is new, act on it" and does not need to diff.
 * That matters on IWSDK, where applying a change means setting `_needsUpdate`
 * and re-running a system.
 */
export interface EnvironmentPort {
  applySky(sky: SkySpec | null): void;
  applyFog(fog: FogSpec | null): void;
  applyAmbient(light: AmbientLightSpec | null): void;
  applyKeyLight(light: KeyLightSpec | null): void;
  /**
   * The environment map. Required like the other four, because a slot the
   * director flushes and a port may quietly not have is a slot that goes
   * missing on one engine and nowhere else.
   */
  applyIbl(ibl: IblSpec | null): void;

  /**
   * Turn real-world depth occlusion on, or off with `null`.
   *
   * OPTIONAL, because a port that cannot do occlusion at all leaves this
   * method off entirely: the director sees it is missing and reports
   * `unsupported` on its own, so there is nothing left for the port to say. A
   * port that HAS this method reports what happens through {@link observe}
   * instead - `pending` once the request is accepted, `active` once it is
   * working, and `unavailable` with a detail when its runtime cannot deliver
   * it right now. The director only calls this while passthrough is on, so a
   * port that never sees it is not necessarily a port on a device without
   * depth.
   */
  applyOcclusion?(spec: OcclusionSpec | null): void;

  /**
   * Start or stop light estimation, with every default already resolved.
   *
   * OPTIONAL, because a port that cannot do light estimation at all leaves
   * this method off entirely: the director sees it is missing and reports
   * `unsupported` on its own, so there is nothing left for the port to say. A
   * port that HAS this method reports what happens through {@link observe}
   * instead - `pending` once the runtime accepted the request, `active` with
   * each estimate, and `unavailable` with a detail when its runtime cannot
   * deliver one right now.
   */
  applyLightEstimation?(estimation: ResolvedLightEstimation | null): void;

  /**
   * Hand the port the object it talks back through.
   *
   * Called once, at construction, before anything is applied. The returned
   * function is called on dispose. This is the ONLY inbound path: see
   * `sensing.ts` for why there is one and why it carries what it does.
   */
  observe?(host: EnvironmentPortHost): (() => void) | void;

  /**
   * Called from `EnvironmentDirector.update`, before any transition advances.
   *
   * Only a port that has to POLL its host needs this, and both of the ones
   * that do are sensor-backed: three.js reports depth sensing through a
   * renderer flag that flips some frames after the session starts, and a light
   * estimate has to be read out of the current `XRFrame` or not at all.
   * Neither host pushes those, so without a tick they would need a loop of
   * their own - which is the thing this package refuses to own.
   */
  update?(deltaMs: number): void;

  /** Release anything the port created. Optional. */
  dispose?(): void;
}

/**
 * Plays sounds.
 *
 * The core owns voice ids, gain resolution and policy; a port owns decoding,
 * routing and the actual noise.
 */
export interface AudioPort {
  /**
   * Prepare a cue. Called once per registration, and may be asynchronous - the
   * director does not wait on it, because a cue that is still loading when it
   * is first played is the adapter's problem to smooth over (queue it, or drop
   * that one play), not a reason to make `play` async for everybody.
   */
  load?(cue: AudioCue): void | Promise<unknown>;
  /** Begin a voice. See `AudioVoiceRequest.ended` for the retirement contract. */
  start(request: AudioVoiceRequest): void;
  /** Stop a voice early. Called at most once per voice, never after `ended`. */
  stop(voiceId: number): void;
  /**
   * Change the gain of a sounding voice, because a bus or the master moved
   * under it. Optional: a port without it simply does not follow live mix
   * changes on voices that are already playing.
   */
  setGain?(voiceId: number, gain: number): void;
  /**
   * Called from `AudioDirector.update`, before the director's own sweep.
   *
   * This exists for a port whose engine reports playback state but not
   * playback END - IWSDK is one - so that it can poll and call `ended`.
   * Without it those ports would have to degrade to fire-and-forget and
   * `restart` / `ignore` would behave differently per engine, which is
   * precisely the kind of divergence this stack exists to remove.
   */
  update?(deltaMs: number): void;
  /** Release anything the port created. Optional. */
  dispose?(): void;
}
