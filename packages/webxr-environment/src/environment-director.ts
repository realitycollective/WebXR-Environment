/**
 * The environment director: presets in, port calls out.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT OWN A LOOP
 * ---------------------------------------------------------------------------
 * `update(dtMs)` is called BY the host - an IWSDK system, a three.js render
 * callback, a test. The director never touches `requestAnimationFrame` and
 * never reads a clock. That is what makes a fifteen-second dusk transition a
 * five-line unit test instead of a stopwatch and a headset, and it is why an
 * XR host that only ticks while the session is focused gets the pausing
 * behaviour it expects for free.
 *
 * ---------------------------------------------------------------------------
 * ONE OWNER FOR THE BACKGROUND
 * ---------------------------------------------------------------------------
 * The reason this exists at all is that "who last wrote `scene.background`"
 * is a race as soon as two features care about the sky. In the client this was
 * extracted from, a passthrough transition and a reveal effect each set the
 * background from a different system and the loser won every other frame.
 *
 * Here there is exactly one writer. Passthrough is not a competing writer
 * either: `setPassthrough(true)` is a SUPPRESSION applied on top of whatever
 * the app asked for, so the app keeps describing the sky it wants, the sky
 * stops being drawn while the real world is showing, and it comes back
 * unchanged when passthrough ends. Nothing has to remember what to restore.
 */
import type {
  EnvironmentSlot,
  EnvironmentSpec,
  ResolvedEnvironment,
} from "./environment.js";
import { EMPTY_ENVIRONMENT } from "./environment.js";
import type { EnvironmentPort } from "./ports.js";
import { deepEquals } from "./equality.js";
import { interpolateEnvironment } from "./interpolate.js";
import type { EasingFunction, EasingName } from "./math.js";
import { clamp01, resolveEasing } from "./math.js";

export interface TransitionOptions {
  /** Milliseconds. `0` or less applies immediately. */
  readonly durationMs?: number;
  readonly easing?: EasingName | EasingFunction;
}

export interface EnvironmentDirectorOptions {
  /** Applied at construction, over an empty environment. */
  readonly initial?: EnvironmentSpec;
  /** Named presets, available to `apply` and `transition` by name. */
  readonly presets?: Readonly<Record<string, EnvironmentSpec>>;
  /** Start in passthrough. Default false. */
  readonly passthrough?: boolean;
  /**
   * Which slots passthrough hides. Default `["sky", "fog"]` - the two that
   * would paint over the real world. Lighting stays, because an AR scene still
   * needs its virtual content lit.
   */
  readonly passthroughSuppresses?: readonly EnvironmentSlot[];
  /** Used by `transition` when the call site gives no options. */
  readonly defaultTransition?: TransitionOptions;
}

/** Fired whenever what the port holds, or what the app asked for, changes. */
export type EnvironmentListener = (
  applied: ResolvedEnvironment,
  requested: ResolvedEnvironment,
) => void;

interface ActiveTransition {
  readonly from: ResolvedEnvironment;
  readonly to: ResolvedEnvironment;
  readonly durationMs: number;
  readonly easing: EasingFunction;
  elapsedMs: number;
}

const DEFAULT_SUPPRESSED: readonly EnvironmentSlot[] = ["sky", "fog"];

function resolveOver(base: ResolvedEnvironment, spec: EnvironmentSpec): ResolvedEnvironment {
  return {
    sky: spec.sky !== undefined ? spec.sky : base.sky,
    fog: spec.fog !== undefined ? spec.fog : base.fog,
    ambient: spec.ambient !== undefined ? spec.ambient : base.ambient,
    key: spec.key !== undefined ? spec.key : base.key,
  };
}

export class EnvironmentDirector {
  readonly #port: EnvironmentPort;
  readonly #presets = new Map<string, EnvironmentSpec>();
  readonly #listeners = new Set<EnvironmentListener>();
  readonly #suppressed: ReadonlySet<EnvironmentSlot>;
  readonly #defaultTransition: TransitionOptions;

  /** What the app asked for, mid-transition included. */
  #requested: ResolvedEnvironment = EMPTY_ENVIRONMENT;
  /** What the port was last told, after suppression. `null` = nothing yet. */
  #applied: ResolvedEnvironment | null = null;
  #transition: ActiveTransition | null = null;
  #passthrough: boolean;
  #disposed = false;

  constructor(port: EnvironmentPort, options: EnvironmentDirectorOptions = {}) {
    this.#port = port;
    this.#suppressed = new Set(options.passthroughSuppresses ?? DEFAULT_SUPPRESSED);
    this.#defaultTransition = options.defaultTransition ?? {};
    this.#passthrough = options.passthrough ?? false;

    for (const [name, spec] of Object.entries(options.presets ?? {})) {
      this.#presets.set(name, spec);
    }
    // Always flush once, even for an empty initial environment: an adapter is
    // entitled to assume the port describes the whole world, and a scene that
    // starts with a leftover background from elsewhere should be cleared.
    if (options.initial !== undefined) {
      this.#requested = resolveOver(EMPTY_ENVIRONMENT, options.initial);
    }
    this.#flush();
  }

  /** Register (or replace) a named preset. */
  define(name: string, spec: EnvironmentSpec): void {
    this.#presets.set(name, spec);
  }

  /** Look a preset up. `undefined` when it was never defined. */
  preset(name: string): EnvironmentSpec | undefined {
    return this.#presets.get(name);
  }

  /** The names currently defined, in insertion order. */
  presetNames(): readonly string[] {
    return [...this.#presets.keys()];
  }

  /** What the app asked for. Mid-transition, the interpolated value. */
  get current(): ResolvedEnvironment {
    return this.#requested;
  }

  /** What the port actually holds - `current` with passthrough applied. */
  get applied(): ResolvedEnvironment {
    return this.#applied ?? EMPTY_ENVIRONMENT;
  }

  get transitioning(): boolean {
    return this.#transition !== null;
  }

  get passthrough(): boolean {
    return this.#passthrough;
  }

  /**
   * Snap to a spec (or preset name). Cancels any transition in flight, so a
   * hard cut always wins over a fade that is still running.
   */
  apply(specOrName: EnvironmentSpec | string): void {
    this.#assertLive();
    this.#transition = null;
    this.#requested = resolveOver(this.#requested, this.#lookup(specOrName));
    this.#flush();
  }

  /**
   * Ease to a spec (or preset name) over `durationMs`. A non-positive duration
   * is an `apply`. Starting a transition while one is running eases from
   * WHERE IT IS NOW, so interrupting a dusk halfway does not jump.
   */
  transition(specOrName: EnvironmentSpec | string, options: TransitionOptions = {}): void {
    this.#assertLive();
    const durationMs = options.durationMs ?? this.#defaultTransition.durationMs ?? 0;
    const target = resolveOver(this.#requested, this.#lookup(specOrName));
    if (durationMs <= 0) {
      this.#transition = null;
      this.#requested = target;
      this.#flush();
      return;
    }
    this.#transition = {
      from: this.#requested,
      to: target,
      durationMs,
      easing: resolveEasing(options.easing ?? this.#defaultTransition.easing),
      elapsedMs: 0,
    };
    // Push t=0 immediately so the slots that cannot interpolate switch on the
    // frame the transition starts rather than on the next tick.
    this.#advance(this.#transition, 0);
  }

  /** Advance an in-flight transition. A no-op when nothing is transitioning. */
  update(deltaMs: number): void {
    const transition = this.#transition;
    if (this.#disposed || transition === null) return;
    this.#advance(transition, deltaMs);
  }

  /** Jump to the end of an in-flight transition. A no-op when there is none. */
  finish(): void {
    this.#assertLive();
    const transition = this.#transition;
    if (transition === null) return;
    this.#transition = null;
    this.#requested = transition.to;
    this.#flush();
  }

  /**
   * Tell the director whether the real world is showing. Push this from
   * whatever already knows - on the Reality Collective stack that is the
   * service framework's capability service - rather than reading a session
   * here: a session is the platform layer's to own, not the environment's.
   */
  setPassthrough(active: boolean): void {
    this.#assertLive();
    if (this.#passthrough === active) return;
    this.#passthrough = active;
    this.#flush();
  }

  /** Subscribe to changes. Returns the unsubscribe. */
  onChange(listener: EnvironmentListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Drop the transition, the listeners, and the port's resources. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#transition = null;
    this.#listeners.clear();
    this.#port.dispose?.();
  }

  #lookup(specOrName: EnvironmentSpec | string): EnvironmentSpec {
    if (typeof specOrName !== "string") return specOrName;
    const preset = this.#presets.get(specOrName);
    if (preset === undefined) {
      throw new Error(
        `[webxr-environment] unknown preset "${specOrName}" (defined: ${
          this.presetNames().join(", ") || "none"
        })`,
      );
    }
    return preset;
  }

  /** The transition is passed in, so this never has to re-test for one. */
  #advance(transition: ActiveTransition, deltaMs: number): void {
    transition.elapsedMs += deltaMs;
    const progress = clamp01(transition.elapsedMs / transition.durationMs);
    this.#requested = interpolateEnvironment(
      transition.from,
      transition.to,
      transition.easing(progress),
    );
    if (progress >= 1) {
      this.#requested = transition.to;
      this.#transition = null;
    }
    this.#flush();
  }

  /** Diff against what the port holds and push only what moved. */
  #flush(): void {
    const next: ResolvedEnvironment = this.#passthrough
      ? {
          sky: this.#suppressed.has("sky") ? null : this.#requested.sky,
          fog: this.#suppressed.has("fog") ? null : this.#requested.fog,
          ambient: this.#suppressed.has("ambient") ? null : this.#requested.ambient,
          key: this.#suppressed.has("key") ? null : this.#requested.key,
        }
      : this.#requested;

    const previous = this.#applied;
    const first = previous === null;
    let changed = first;

    if (first || !deepEquals(previous.sky, next.sky)) {
      this.#port.applySky(next.sky);
      changed = true;
    }
    if (first || !deepEquals(previous.fog, next.fog)) {
      this.#port.applyFog(next.fog);
      changed = true;
    }
    if (first || !deepEquals(previous.ambient, next.ambient)) {
      this.#port.applyAmbient(next.ambient);
      changed = true;
    }
    if (first || !deepEquals(previous.key, next.key)) {
      this.#port.applyKeyLight(next.key);
      changed = true;
    }

    this.#applied = next;
    if (!changed) return;
    for (const listener of this.#listeners) listener(next, this.#requested);
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error("[webxr-environment] the environment director has been disposed");
    }
  }
}
