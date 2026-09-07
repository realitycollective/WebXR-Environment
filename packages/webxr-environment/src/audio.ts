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
 * Omitted fields are the host's own defaults, which is why there is no
 * "resolved" form of this. The core has no opinion about how far a sound
 * carries.
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
   * The cue's attenuation, or null when it named none and the port should use
   * its own defaults. Resolved here so a port never reads the cue for policy.
   */
  readonly spatial: AudioSpatial | null;
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
