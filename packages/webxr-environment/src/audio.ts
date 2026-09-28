/**
 * The audio contract: what a sound IS, described as plain data, and what a
 * request to play one looks like once the core has resolved it.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS SITS
 * ---------------------------------------------------------------------------
 * This package plays sounds when it is asked to. It has no notion of WHY, and
 * it knows about no other package.
 *
 * Deciding that a sound should happen is the app's. An interaction fired, a
 * level changed, a timer elapsed, a message arrived - the app subscribes to
 * whatever it has and calls `play`. If that source is present it gets bound;
 * if it is not, nothing happens and nothing here notices. Nothing in this
 * package imports, names or type-checks against a sibling package, and nothing
 * needs to import this one to be heard.
 *
 * `AudioCue` therefore describes a SOUND, never an event: an id the app
 * chooses, a file the adapter resolves, and how it should behave when it is
 * triggered repeatedly. What triggers it is not modelled here at all.
 */
import type { Vec3 } from "./environment.js";

/** A mix group. Any string works; the conventional set is below. */
export type AudioBus = string;

/**
 * The buses a director starts with, each at unity gain. Any other name works
 * too - a bus springs into existence at unity the first time it is named.
 * `master` is NOT in here: it is a separate scalar over all buses, so that
 * "duck everything" and "turn the music down" never fight over one number.
 */
export const DEFAULT_BUSES = ["music", "sfx", "voice", "ambience", "ui"] as const;

/** The bus a cue lands on when it does not name one. */
export const DEFAULT_BUS = "sfx";

/** What a second play request does while a cue is already sounding. */
export type CuePolicy =
  /** Start another voice. The default. */
  | "overlap"
  /** Stop the sounding voices, then start a new one. */
  | "restart"
  /** Drop the request. */
  | "ignore";

/**
 * How a positional voice gets quieter with distance.
 *
 * Every field is something all three hosts already expose per source - three's
 * `PositionalAudio` has `setRefDistance`, `setRolloffFactor`, `setMaxDistance`
 * and `setDistanceModel`; IWSDK's `AudioSource` has the same four, one of them
 * as a `DistanceModel` enum; XR Blocks' spatial audio has its own equivalents.
 * Leaving them out of the contract does not make the stack portable, it makes
 * every adapter apply one constant to every sound, which is the opposite of
 * the job: a footstep and a waterfall do not fall off at the same rate.
 *
 * Omitted fields take `AUDIO_ATTENUATION_DEFAULTS`, Web Audio's own panner
 * defaults, the values every web host inherited without saying so and a
 * native host had no way to know: the director resolves them
 * (`resolveAudioSpatial`) before a request reaches a port, so a positional
 * voice carries the same attenuation on every platform.
 */
export interface AudioSpatial {
  /** Metres at which the sound is at full volume. */
  readonly refDistance?: number;
  /** How quickly it falls off past that. Higher is faster. */
  readonly rolloffFactor?: number;
  /** Metres past which it gets no quieter. */
  readonly maxDistance?: number;
  /** The attenuation curve. Web Audio's three, which every host maps to. */
  readonly model?: "linear" | "inverse" | "exponential";
  /**
   * Which way the sound points, and how narrowly.
   *
   * Distance says how quiet a sound gets as you walk away; this says how quiet
   * it gets as you walk AROUND it. A television, a PA horn and a person
   * talking are all quieter behind than in front, and without this every one
   * of them plays as a glowing orb of sound.
   *
   * The cone is a property of the CUE, because it describes what kind of thing
   * is making the noise. Which way that particular one is turned is a property
   * of the play - see `PlayOptions.facing`.
   */
  readonly cone?: AudioCone;
}

/**
 * A directional sound, in this package's own terms.
 *
 * Angles are RADIANS, like every other angle here, and are the FULL width of
 * the cone rather than a half-angle. Both current hosts want degrees, because
 * both are wrapping the same Web Audio panner underneath - IWSDK reaches it
 * through a component, three.js through `setDirectionalCone` - and each
 * adapter converts. That is the whole point of naming it here: the app says
 * one thing, and what the platform happens to want is the adapter's problem.
 */
export interface AudioCone {
  /** Full width of the cone inside which the sound is at full volume. */
  readonly inner: number;
  /** Full width of the cone by which it has faded to `outsideGain`. */
  readonly outer: number;
  /** How loud it still is outside the outer cone, 0..1. */
  readonly outsideGain: number;
}

/**
 * The attenuation a positional voice has when its cue says nothing: Web
 * Audio's `PannerNode` defaults, which IWSDK's `AudioSource` and three.js's
 * `PositionalAudio` both pass straight through. Inverse distance, full
 * volume within 1 m, falling as `1 / (1 + (d - 1))` beyond it out to 10 km,
 * and a cone of 360 degrees inside and out (omnidirectional) with nothing
 * left outside it. Angles here are radians, as `AudioCone` states.
 */
export const AUDIO_ATTENUATION_DEFAULTS: Readonly<Required<Omit<AudioSpatial, "cone">> & { readonly cone: AudioCone }> = Object.freeze({
  refDistance: 1,
  rolloffFactor: 1,
  maxDistance: 10000,
  model: "inverse",
  cone: Object.freeze({ inner: 2 * Math.PI, outer: 2 * Math.PI, outsideGain: 0 }),
});

/** A cue's attenuation with every omitted field filled from `AUDIO_ATTENUATION_DEFAULTS`. */
export function resolveAudioSpatial(spatial: AudioSpatial | null | undefined): Required<AudioSpatial> {
  const cone = spatial?.cone ?? AUDIO_ATTENUATION_DEFAULTS.cone;
  return {
    refDistance: spatial?.refDistance ?? AUDIO_ATTENUATION_DEFAULTS.refDistance,
    rolloffFactor: spatial?.rolloffFactor ?? AUDIO_ATTENUATION_DEFAULTS.rolloffFactor,
    maxDistance: spatial?.maxDistance ?? AUDIO_ATTENUATION_DEFAULTS.maxDistance,
    model: spatial?.model ?? AUDIO_ATTENUATION_DEFAULTS.model,
    cone: { inner: cone.inner, outer: cone.outer, outsideGain: cone.outsideGain },
  };
}

/**
 * The gain factor (0..1) distance alone leaves a positional voice with, by
 * the Web Audio distance models every host maps to (`PannerNode`
 * `distanceModel`): the rule a native host applies and the conformance kit
 * checks. `distance` is metres from the listener; it is clamped to
 * `refDistance` below and, for `"linear"` and `"exponential"`, to
 * `maxDistance` above.
 */
export function distanceGain(distance: number, spatial: AudioSpatial | null | undefined): number {
  const { refDistance, rolloffFactor, maxDistance, model } = resolveAudioSpatial(spatial);
  const d = Math.max(distance, refDistance);
  if (model === "linear") {
    const clamped = Math.min(d, maxDistance);
    return Math.max(0, 1 - (rolloffFactor * (clamped - refDistance)) / Math.max(maxDistance - refDistance, 1e-9));
  }
  if (model === "exponential") {
    return Math.pow(Math.min(d, maxDistance) / refDistance, -rolloffFactor);
  }
  return refDistance / (refDistance + rolloffFactor * (d - refDistance));
}

/**
 * The listener rule: the listener is the viewer's head. Its position and
 * orientation are the head pose every frame, so a positional voice is heard
 * from where the viewer is and facing the way the viewer faces. On the web
 * this is the `AudioListener` on the camera (IWSDK's `AudioSystem`, three.js's
 * `AudioListener`); a native host places its engine's listener at the head
 * pose its `input` slice reports, every frame. Stated as a value so a host
 * can be checked against it.
 */
export const AUDIO_LISTENER_RULE = "head" as const;

/** A sound the app knows how to make. Registered once, played by id. */
export interface AudioCue {
  /** The name gameplay uses. Unique within a director. */
  readonly id: string;
  /** Where the audio lives. Resolved by the adapter, not by the core. */
  readonly src: string;
  /** Mix group. Default `"sfx"`. */
  readonly bus?: AudioBus;
  /** Per-cue trim, multiplied into the bus gain. Default 1. */
  readonly gain?: number;
  /** Loop until stopped. Default false. */
  readonly loop?: boolean;
  /** Play from a point in the world rather than from the listener. */
  readonly positional?: boolean;
  /** How this cue falls off with distance. Positional cues only. */
  readonly spatial?: AudioSpatial;
  /** Retrigger policy. Default `"overlap"`. */
  readonly policy?: CuePolicy;
  /**
   * Minimum gap between two accepted plays of this cue, milliseconds. A
   * request inside the window is dropped. This is what stops a feedback
   * intent firing every frame from turning into a chainsaw.
   */
  readonly minIntervalMs?: number;
  /**
   * How long the sound runs, milliseconds. Optional, and only used to retire
   * a voice on a port that cannot tell us when playback finished - see
   * `AudioPort.start`. A looping cue ignores it.
   */
  readonly durationMs?: number;
}

/** Per-play overrides. Everything here beats the cue's own value. */
export interface PlayOptions {
  /** Extra trim for this play, multiplied in. Default 1. */
  readonly gain?: number;
  /** Where in the world it comes from. Implies positional playback. */
  readonly at?: Vec3;
  /**
   * Which way it faces: the direction the sound TRAVELS, as `[x, y, z]`.
   *
   * The same convention as `KeyLightSpec.direction`, and for the same reason -
   * one rule for direction across the package, and the hosts' own ideas of
   * forward (three.js audio points along +Z) absorbed by the adapters.
   *
   * Only meaningful with a cue that has a `cone`. A zero-length vector, or
   * none at all, leaves the sound pointing wherever the host puts it.
   */
  readonly facing?: Vec3;
  /** Override the cue's `loop`. */
  readonly loop?: boolean;
}

/** A sounding voice. Opaque to the app apart from the fields shown. */
export interface AudioVoice {
  readonly id: number;
  readonly cueId: string;
  readonly bus: AudioBus;
}

/**
 * A play request with every decision already made: which file, how loud in
 * absolute terms, looping or not, and where from. An adapter implementing
 * `AudioPort` has no mixing left to do.
 */
export interface AudioVoiceRequest {
  readonly voiceId: number;
  readonly cue: AudioCue;
  /** Absolute gain, master x bus x cue x play, clamped at 0. */
  readonly gain: number;
  readonly loop: boolean;
  /** World position, or null for playback from the listener. */
  readonly at: Vec3 | null;
  /**
   * The attenuation for a positional voice, every field resolved
   * (`resolveAudioSpatial`), or null for a voice played from the listener.
   * A port applies exactly these values and never its engine's defaults.
   */
  readonly spatial: Required<AudioSpatial> | null;
  /** Which way this voice faces, or null. See `PlayOptions.facing`. */
  readonly facing: Vec3 | null;
  /**
   * The port calls this ONCE when the voice stops of its own accord, so the
   * director can retire it. A port that fires and forgets a one-shot should
   * call it immediately; the voice is then untracked, and `restart` / `ignore`
   * degrade to `overlap` for that cue. A port that cannot report the end of a
   * LOOPING voice is broken - loops are always stoppable.
   */
  readonly ended: () => void;
}
