/**
 * The audio director: cues in, resolved voices out.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT OWNS, AND WHY IT IS NOT IN THE ADAPTER
 * ---------------------------------------------------------------------------
 * Every engine can play a sound. What no engine agrees on is the part around
 * it: how loud a cue is once the music bus has been ducked, whether triggering
 * the same cue twice restarts the sound or layers it, and what stops a cue
 * fired every frame from turning into a chainsaw. Put that in the adapter and
 * it gets written once per engine, three ways, and the app behaves differently
 * on each. So it lives here, once, headlessly testable, and the port is handed
 * an absolute gain and told to make a noise.
 *
 * ---------------------------------------------------------------------------
 * IT IS A SINK, NOT A SOURCE
 * ---------------------------------------------------------------------------
 * `play(cueId, options?)` is the whole of the inbound surface, and it is an
 * ordinary method on an ordinary object. The app subscribes to whatever it
 * already has - an interaction event, a state change, a timer, a socket - and
 * calls it. One line, in the app, where both halves are already in scope:
 *
 *   unsubscribe = someEmitter.on("thing", () => audio.play("click"));
 *
 * That is deliberate and it is the point. This class does not know what an
 * interaction is, no adapter for one is provided, and no sibling package is
 * imported, named in a type, or asserted against in a test. If a source is
 * present the app binds it; if it is not, nothing here changes.
 *
 * A caller's `gain` is RELATIVE: the bus and master still apply over it, so
 * whatever is bound to this is a peer and never an owner of the player's mix.
 */
import type {
  AudioBus,
  AudioCue,
  AudioVoice,
  AudioVoiceRequest,
  PlayOptions,
} from "./audio.js";
import { DEFAULT_BUS } from "./audio.js";
import type { AudioPort } from "./ports.js";

export interface AudioDirectorOptions {
  /** Cues to register at construction. */
  readonly cues?: Iterable<AudioCue>;
  /** Starting bus gains. A bus not named here starts at 1. */
  readonly busGains?: Readonly<Record<string, number>>;
  /** Starting master gain. Default 1. */
  readonly masterGain?: number;
  /**
   * Clock for `minIntervalMs`, milliseconds, monotonic-ish. Injected so the
   * throttle is testable without timers; defaults to `Date.now`.
   */
  readonly now?: () => number;
}

interface Voice {
  readonly id: number;
  readonly cueId: string;
  readonly bus: AudioBus;
  /** cue gain x play gain - everything the mix does not control. */
  readonly trim: number;
  readonly loop: boolean;
  readonly durationMs: number | null;
  elapsedMs: number;
}

export class AudioDirector {
  readonly #port: AudioPort;
  readonly #cues = new Map<string, AudioCue>();
  readonly #voices = new Map<number, Voice>();
  readonly #busGains = new Map<string, number>();
  readonly #mutedBuses = new Set<string>();
  readonly #lastPlayedAt = new Map<string, number>();
  readonly #now: () => number;

  #masterGain: number;
  #masterMuted = false;
  #nextVoiceId = 1;
  #disposed = false;

  constructor(port: AudioPort, options: AudioDirectorOptions = {}) {
    this.#port = port;
    this.#now = options.now ?? (() => Date.now());
    this.#masterGain = options.masterGain ?? 1;
    for (const [bus, gain] of Object.entries(options.busGains ?? {})) {
      this.#busGains.set(bus, gain);
    }
    for (const cue of options.cues ?? []) this.register(cue);
  }

  // --- registry ------------------------------------------------------------

  /** Register a cue, replacing any cue already using that id. */
  register(cue: AudioCue): void {
    this.#assertLive();
    this.#cues.set(cue.id, cue);
    void this.#port.load?.(cue);
  }

  registerAll(cues: Iterable<AudioCue>): void {
    for (const cue of cues) this.register(cue);
  }

  has(cueId: string): boolean {
    return this.#cues.has(cueId);
  }

  cue(cueId: string): AudioCue | undefined {
    return this.#cues.get(cueId);
  }

  cueIds(): readonly string[] {
    return [...this.#cues.keys()];
  }

  // --- mix -----------------------------------------------------------------

  get masterGain(): number {
    return this.#masterGain;
  }

  setMasterGain(gain: number): void {
    this.#assertLive();
    const next = Math.max(0, gain);
    if (next === this.#masterGain) return;
    this.#masterGain = next;
    this.#refreshVoiceGains();
  }

  /** A bus that has never been set reads 1. */
  getBusGain(bus: AudioBus): number {
    return this.#busGains.get(bus) ?? 1;
  }

  setBusGain(bus: AudioBus, gain: number): void {
    this.#assertLive();
    const next = Math.max(0, gain);
    if (this.getBusGain(bus) === next) return;
    this.#busGains.set(bus, next);
    this.#refreshVoiceGains(bus);
  }

  /**
   * Mute a bus, or everything when no bus is named. Muting is separate from
   * gain so that unmuting restores the level the player set rather than a
   * remembered one, which is the bug every "set it to zero" mute eventually
   * grows.
   */
  setMuted(muted: boolean, bus?: AudioBus): void {
    this.#assertLive();
    if (bus === undefined) {
      if (this.#masterMuted === muted) return;
      this.#masterMuted = muted;
      this.#refreshVoiceGains();
      return;
    }
    const already = this.#mutedBuses.has(bus);
    if (already === muted) return;
    if (muted) this.#mutedBuses.add(bus);
    else this.#mutedBuses.delete(bus);
    this.#refreshVoiceGains(bus);
  }

  isMuted(bus?: AudioBus): boolean {
    return bus === undefined ? this.#masterMuted : this.#mutedBuses.has(bus);
  }

  /** The absolute gain a play of `cueId` would resolve to right now. */
  resolveGain(cueId: string, extra = 1): number {
    const cue = this.#cues.get(cueId);
    if (cue === undefined) return 0;
    return this.#gainFor(cue.bus ?? DEFAULT_BUS, (cue.gain ?? 1) * extra);
  }

  // --- playback ------------------------------------------------------------

  /**
   * Play a cue. Returns the voice, or `null` when the request was dropped -
   * an unknown cue, a throttle window, an `ignore` policy with the cue already
   * sounding, or a one-shot that would have been silent anyway.
   *
   * Dropping rather than throwing is deliberate: a missing sound must never
   * take gameplay down with it, and by the time a cue id reaches here it has
   * usually come from a feedback intent several layers away.
   */
  play(cueId: string, options: PlayOptions = {}): AudioVoice | null {
    this.#assertLive();
    const cue = this.#cues.get(cueId);
    if (cue === undefined) return null;

    const now = this.#now();
    if (cue.minIntervalMs !== undefined) {
      const last = this.#lastPlayedAt.get(cueId);
      if (last !== undefined && now - last < cue.minIntervalMs) return null;
    }

    const policy = cue.policy ?? "overlap";
    if (policy !== "overlap") {
      const sounding = this.#voicesOfCue(cueId);
      if (sounding.length > 0) {
        if (policy === "ignore") return null;
        for (const voice of sounding) this.#stopVoice(voice.id);
      }
    }

    const bus = cue.bus ?? DEFAULT_BUS;
    const trim = (cue.gain ?? 1) * (options.gain ?? 1);
    const gain = this.#gainFor(bus, trim);
    const loop = options.loop ?? cue.loop ?? false;

    // A silent one-shot is a voice nobody will ever hear; skip the port
    // entirely. A silent LOOP still starts, because unmuting mid-flight is
    // exactly when an ambience bed needs to already be running.
    this.#lastPlayedAt.set(cueId, now);
    if (gain <= 0 && !loop) return null;

    const id = this.#nextVoiceId;
    this.#nextVoiceId += 1;
    const voice: Voice = {
      id,
      cueId,
      bus,
      trim,
      loop,
      durationMs: !loop && cue.durationMs !== undefined ? cue.durationMs : null,
      elapsedMs: 0,
    };
    // Registered BEFORE `start`, because a fire-and-forget port calls `ended`
    // synchronously from inside it.
    this.#voices.set(id, voice);

    const request: AudioVoiceRequest = {
      voiceId: id,
      cue,
      gain,
      loop,
      at: options.at ?? null,
      ended: () => {
        this.#voices.delete(id);
      },
    };
    this.#port.start(request);

    return { id, cueId, bus };
  }

  /** Stop one voice. Safe to call on a voice that already finished. */
  stop(voice: AudioVoice | number): void {
    this.#assertLive();
    this.#stopVoice(typeof voice === "number" ? voice : voice.id);
  }

  /** Stop every sounding voice of a cue. */
  stopCue(cueId: string): void {
    this.#assertLive();
    for (const voice of this.#voicesOfCue(cueId)) this.#stopVoice(voice.id);
  }

  /** Stop everything, or everything on one bus. */
  stopAll(bus?: AudioBus): void {
    this.#assertLive();
    for (const voice of [...this.#voices.values()]) {
      if (bus === undefined || voice.bus === bus) this.#stopVoice(voice.id);
    }
  }

  /** The voices the director believes are sounding. */
  get activeVoices(): readonly AudioVoice[] {
    return [...this.#voices.values()].map(({ id, cueId, bus }) => ({ id, cueId, bus }));
  }

  /**
   * Retire one-shot voices whose declared `durationMs` has elapsed.
   *
   * Only needed for a port that cannot report the end of playback. A port that
   * calls `ended` retires its voices earlier and this finds nothing to do, so
   * a host may call it unconditionally alongside the environment director's
   * `update` and not care which kind of port it has.
   */
  update(deltaMs: number): void {
    if (this.#disposed) return;
    // The port first: a port that can observe the end of playback retires its
    // voices here, and the declared-duration sweep below then finds nothing.
    this.#port.update?.(deltaMs);
    for (const voice of this.#voices.values()) {
      if (voice.durationMs === null) continue;
      voice.elapsedMs += deltaMs;
      if (voice.elapsedMs >= voice.durationMs) this.#voices.delete(voice.id);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const id of [...this.#voices.keys()]) this.#stopVoice(id);
    this.#disposed = true;
    this.#cues.clear();
    this.#lastPlayedAt.clear();
    this.#port.dispose?.();
  }

  // --- internals -----------------------------------------------------------

  #gainFor(bus: string, trim: number): number {
    if (this.#masterMuted || this.#mutedBuses.has(bus)) return 0;
    return Math.max(0, this.#masterGain * this.getBusGain(bus) * trim);
  }

  #voicesOfCue(cueId: string): Voice[] {
    return [...this.#voices.values()].filter((voice) => voice.cueId === cueId);
  }

  #stopVoice(id: number): void {
    if (!this.#voices.delete(id)) return;
    this.#port.stop(id);
  }

  /** Push new gains onto sounding voices after a mix change. */
  #refreshVoiceGains(bus?: string): void {
    const setGain = this.#port.setGain;
    if (setGain === undefined) return;
    for (const voice of this.#voices.values()) {
      if (bus !== undefined && voice.bus !== bus) continue;
      setGain.call(this.#port, voice.id, this.#gainFor(voice.bus, voice.trim));
    }
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error("[webxr-environment] the audio director has been disposed");
    }
  }
}
