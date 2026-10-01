/**
 * The four slices of `globalThis.__rcHost` this family reads, and the code
 * that finds them.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE SHAPES AND NOT THE PORTS THEMSELVES
 * ---------------------------------------------------------------------------
 * A native host is not a TypeScript object with a vtable, it is whatever the
 * embedding app installs before the bundle runs - Swift, Kotlin, C++, whatever
 * calls into Hermes. Everything that crosses is plain: numbers, strings,
 * booleans, arrays, plain objects and `Uint8Array`. The only functions that
 * cross are listener callbacks passed to an `on*` method, and each one returns
 * an unsubscribe function. See `NATIVE_HOST_CONTRACT.md`, "Rules for every
 * slice".
 *
 * So these three interfaces are NOT `EnvironmentPort` / `AudioPort` /
 * `WorldSensingPort` renamed. Each is that port's signature translated to the
 * boundary: an inbound path (`observe`, a report, a callback the port
 * receives) becomes an `on*` method the host calls, because the host cannot
 * hold a reference to a `Port` object and call methods on it whenever it
 * pleases - it can only be given a function and told to call it. Everything
 * else forwards one for one.
 *
 * ---------------------------------------------------------------------------
 * EVERY SLICE EXCEPT THE ROOT IS OPTIONAL
 * ---------------------------------------------------------------------------
 * `environment` and `audio` are each required by the ONE port that reads them
 * - a native app with no environment story has no reason to install
 * `__rcHost.environment`, but an app that does not is an app whose
 * `NativeEnvironmentPort` cannot be built, and the error at construction says
 * exactly that. `sensing` is different: a `NativeWorldSensingPort` is meant to
 * exist on a host with no world-sensing story at all, reporting `unsupported`
 * for everything, so its slice is read without ever throwing.
 */
import type {
  AmbientLightSpec,
  AudioCue,
  AudioVoiceRequest,
  EstimatedLighting,
  FogSpec,
  HitTestRequest,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  ResolvedWorldDetection,
  SceneDefinition,
  SensingReport,
  SkySpec,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldPose,
} from "@realitycollective/webxr-environment";

/** The name of the global the native app installs. Shared with the root package. */
export const NATIVE_HOST_GLOBAL = "__rcHost";

/**
 * `EnvironmentPort`, at the native boundary.
 *
 * The five required methods are `applySky` through `applyIbl`: every host in
 * this estate implements them, because a slot the director flushes and a port
 * quietly does not have is a slot that goes missing on one platform and
 * nowhere else - see `EnvironmentPort.applyIbl`. `applyOcclusion` and
 * `applyLightEstimation` stay optional, and so does everything about telling
 * JavaScript what happened: a host with neither `onSensingReport` nor
 * `onLightEstimate` is a host that can still draw sky, fog and light, and gets
 * to.
 */
export interface NativeEnvironmentHost {
  /**
   * Draw the sky, or none with `null`. The DIRECTOR decides every value: it
   * has already interpolated a transition (four easings, `linear` by default,
   * a zero default duration so a transition without one snaps) and applied
   * suppression, so passthrough hands `null` here (sky and fog are the
   * default suppressed slots, sky alone under depth occlusion) and the real
   * spec again when it ends. The host draws exactly the kind named:
   * `gradient` (top, bottom, optional equator colour at `horizon`, a fraction
   * of the way up; `exponent` sharpens above 1, default 1; `intensity`
   * default 1), `solid`, or `texture` (`src`, `intensity`, `rotationY` in
   * radians, `blur` 0..1). Colours are linear `[r, g, b]` in 0..1. Called in
   * slot order: sky, fog, ambient, key, ibl. IWSDK: `IWSDKEnvironmentPort.applySky`.
   */
  applySky(sky: SkySpec | null): void;
  /**
   * Draw fog, or none with `null`: `linear` from `near` to `far` metres, or
   * `exponential` with `density` per metre. A present fog with density 0 is
   * invisible but still present, so a transition eases rather than snaps.
   * IWSDK: `IWSDKEnvironmentPort.applyFog` (three.js `Fog` or `FogExp2`).
   */
  applyFog(fog: FogSpec | null): void;
  /** Uniform light: linear colour and a scalar intensity, or none. IWSDK: `applyAmbient`. */
  applyAmbient(light: AmbientLightSpec | null): void;
  /**
   * The one directional light: colour, intensity, and `direction`, the way
   * the light TRAVELS in world space (`[0, -1, 0]` is overhead), with
   * `castShadow` when the scene asks for shadows. IWSDK: `applyKeyLight`.
   */
  applyKeyLight(light: KeyLightSpec | null): void;
  /**
   * The environment map PBR materials reflect, or none: `gradient`,
   * `texture`, or `room` (the platform's own room probe). IWSDK: `applyIbl`
   * (`IBLGradient`, `IBLTexture`, IWSDK's own room probe).
   */
  applyIbl(ibl: IblSpec | null): void;
  /**
   * Depth occlusion on, or off with `null`. The director calls this only
   * while passthrough is on, and REMEMBERS a spec set earlier, applying it
   * when passthrough starts. A host without it is reported `unsupported`.
   * IWSDK: `IWSDKEnvironmentPort.applyOcclusion`.
   */
  applyOcclusion?(spec: OcclusionSpec | null): void;
  /** Light estimation on, with every default resolved, or off with `null`. IWSDK has none (0.5.3 and 1.0.0). */
  applyLightEstimation?(spec: ResolvedLightEstimation | null): void;
  /** State changed for a sensor-backed feature: `occlusion`, `lightEstimation`, `depthTexture`. */
  onSensingReport?(callback: (report: SensingReport) => void): () => void;
  /** New measured lighting, or `null` when estimation stopped. */
  onLightEstimate?(callback: (estimate: EstimatedLighting | null) => void): () => void;
}

/**
 * `AudioVoiceRequest`, minus the one member that cannot cross: `ended` is a
 * callback the CORE calls when the host is done with a voice, and the native
 * boundary carries only listener callbacks the host itself invokes. The port
 * keeps `ended` in JavaScript, keyed by `voiceId`, and runs it when
 * `NativeAudioHost.onVoiceEnded` names that id - see `audio-port.ts`.
 */
export type NativeAudioVoiceRequest = Omit<AudioVoiceRequest, "ended">;

/**
 * `AudioPort`, at the native boundary.
 *
 * `start` and `stop` are the only two a host must implement; a host that
 * cannot report when a voice finishes on its own is not one this contract can
 * describe, so `onVoiceEnded` is required alongside them. `load` and
 * `setGain` stay optional, exactly as they are on `AudioPort`.
 */
export interface NativeAudioHost {
  /** Decode a cue's `src` ahead of its first play. Optional. */
  load?(cue: AudioCue): void | Promise<unknown>;
  /**
   * Start one voice. The DIRECTOR has already applied the policy: `overlap`
   * (the default) starts another voice, `restart` stopped the sounding ones
   * first, `ignore` never gets here while one sounds, and `minIntervalMs`
   * throttling dropped a play too soon after the last. So the host starts
   * exactly what it is handed: `gain` is absolute (master x bus x cue x play,
   * never below 0), `loop` loops, `at` is a world position in metres or
   * `null` for a voice heard from the listener with no attenuation at all.
   *
   * `spatial` is the attenuation of a positional voice, EVERY field resolved
   * by the core (`AUDIO_ATTENUATION_DEFAULTS` in
   * `@realitycollective/webxr-environment`, Web Audio's panner defaults):
   * `model` is the distance curve (`"inverse"`: full volume within
   * `refDistance` metres, then `ref / (ref + rolloff * (d - ref))`;
   * `"linear"`, `"exponential"` as Web Audio defines them), `maxDistance` in
   * metres past which it gets no quieter, and `cone.inner`/`cone.outer` are
   * the FULL cone widths in RADIANS about `facing` inside which the voice is
   * at full volume and beyond which it is at `cone.outsideGain`. The host
   * applies exactly these, never its engine's own defaults; the core's
   * `distanceGain` states the number the kit checks. `null` only for a voice
   * played from the listener.
   *
   * The listener is the viewer's head: the host places its engine's listener
   * at the head pose the `input` slice reports, position and orientation,
   * every frame (`AUDIO_LISTENER_RULE`). IWSDK: the `AudioListener` on the
   * camera.
   *
   * One voice per request, never pooled or merged: IWSDK's `IWSDKAudioPort`
   * gives each voice its own entity and pins its playback mode to overlap so
   * its engine never second-guesses the director.
   */
  start(request: NativeAudioVoiceRequest): void;
  /** Stop one voice. Called at most once per voice, and never after `onVoiceEnded` named it. */
  stop(voiceId: number): void;
  /** Change a sounding voice's absolute gain. Optional. */
  setGain?(voiceId: number, gain: number): void;
  /**
   * The host retired a voice of its own accord: a one-shot finished, or a
   * voice failed to start. Report a failed start promptly - `NativeAudioPort`
   * also releases a voice locally once it has waited `startTimeoutMs`
   * (10 000 ms by default, the same wait IWSDK uses) without hearing either
   * way, but that is a backstop for a host that forgets, not a replacement
   * for reporting the failure. Never for a voice `stop` ended.
   */
  onVoiceEnded(callback: (voiceId: number) => void): () => void;
}

/**
 * Test-only readbacks for the environment and audio host conformance kit
 * (`nativeEnvironmentHostConformanceCases`). A shipping host may omit them.
 *
 * `applied(slot)` and `appliedOcclusion()` report what the host was HANDED -
 * they prove the value crossed the boundary correctly, never that the host
 * did anything sensible with it. The members below report what the host is
 * actually DRAWING, derived from its own rendering state: a host can echo a
 * gradient sky back through `applied("sky")` correctly and still be painting
 * a flat colour, and only a readback that asks "what kind are you actually
 * drawing" catches that. Every one of them is `undefined` before the related
 * `apply*` was ever called.
 */
export interface NativeEnvironmentTestHost {
  /** What the host is drawing for a slot now: the last value it was handed, `null` for none, `undefined` before any. */
  applied(slot: "sky" | "fog" | "ambient" | "key" | "ibl"): unknown;
  /** The occlusion spec the host is applying now, `null` for off, `undefined` if it was never handed one. */
  appliedOcclusion(): OcclusionSpec | null | undefined;
  /**
   * The kind of sky the host is actually rendering right now - `"solid"`,
   * `"gradient"` or `"texture"` - from its own drawing state, `null` for no
   * sky. A host that renders every kind the same way (a gradient painted flat,
   * a texture never bound) reports the wrong kind here even though
   * `applied("sky")` shows the correct spec was received.
   */
  drawnSkyKind(): "solid" | "gradient" | "texture" | null | undefined;
  /**
   * The kind of fog the host is actually rendering right now - `"linear"` or
   * `"exponential"` - from its own drawing state, `null` for no fog. See
   * `drawnSkyKind` for why this is not the same question as `applied("fog")`.
   */
  drawnFogKind(): "linear" | "exponential" | null | undefined;
  /**
   * Whether the host's key light is actually casting a shadow right now, from
   * its own rendering state - not merely the `castShadow` field of whatever
   * `applyKeyLight` last received. `null` while there is no key light.
   */
  drawnKeyLightCastsShadow(): boolean | null | undefined;
  /**
   * Whether the host's materials are actually reflecting an environment map
   * right now, from its own rendering state - not merely whether `applyIbl`
   * was last handed a non-null spec.
   */
  drawnIblActive(): boolean | undefined;
  /** The resolved light-estimation request the host's `applyLightEstimation` last received, `null` for off, `undefined` before any. */
  appliedLightEstimation(): ResolvedLightEstimation | null | undefined;
}

/** Test-only readback for the audio host cases. */
export interface NativeAudioTestHost {
  /** Every voice the host is sounding now. */
  voices(): readonly { readonly voiceId: number; readonly cueId: string }[];
  /**
   * The gain factor (0..1) distance attenuation leaves a sounding positional
   * voice with now, before the request's own `gain`: 1 within
   * `refDistance`, `distanceGain(d, spatial)` beyond. Optional; the
   * attenuation case fails a host without it.
   */
  voiceDistanceGain?(voiceId: number): number;
  /** Where the host's audio listener is now, world space. Optional; the listener case fails a host without it. */
  listenerPose?(): WorldPose;
}

/**
 * `WorldSensingPort` and `WorldSensingPortHost`, at the native boundary, as
 * one slice: every member is optional, because `sensing` itself is optional
 * and a host that has it may still only detect some of what the port asks
 * about. `NativeWorldSensingPort` wires exactly the members present and
 * leaves the rest off itself, so `WorldSensingDirector`'s own "the port does
 * not have this" reporting is what an app sees - see `world-sensing-port.ts`.
 */
export interface NativeSensingHost {
  /** Detect planes and meshes as `detection` says, every default resolved, or stop with `null`. Answer through `onSensingReport`. */
  setDetection?(detection: ResolvedWorldDetection | null): void;
  /** Start a standing hit test for `request.id`; answers arrive through `onHits` under that id, world space, metres. */
  startHitTest?(request: HitTestRequest): void;
  /** Stop a standing hit test. An unknown id is ignored. */
  stopHitTest?(id: string): void;
  /** Anchor a world pose; resolve its id, or `null` when the runtime refuses. Never reject. */
  createAnchor?(pose: WorldPose): Promise<string | null>;
  /** Remove an anchor. An unknown id is ignored. */
  removeAnchor?(id: string): void;
  /** The whole current set of planes. Anything absent is treated as gone. */
  onPlanes?(callback: (planes: readonly WorldPlane[]) => void): () => void;
  onMeshes?(callback: (meshes: readonly WorldMesh[]) => void): () => void;
  onAnchors?(callback: (anchors: readonly WorldAnchor[]) => void): () => void;
  /** The current answers for one standing hit-test request, named by its id. */
  onHits?(callback: (sourceId: string, hits: readonly WorldHit[]) => void): () => void;
  /** State changed for a world feature: `planes`, `meshes`, `anchors`, `hitTest`. */
  onSensingReport?(callback: (report: SensingReport) => void): () => void;
}

/** What the native app built for one scene: its own key for it, and every node by id. */
export interface NativeBuiltScene {
  /** The app's key for the scene. Unique among everything the app has keyed. */
  readonly scene: string;
  /**
   * Every addressable node: its id in the scene, and the app's key for it.
   * A node's key is also the target id the app uses for it in the
   * `interactions` slice, which is how a target registered against a scene
   * node resolves to that node.
   */
  readonly nodes: readonly { readonly id: string; readonly key: string }[];
}

/**
 * `ScenePort`, at the native boundary: the `scenes` slice.
 *
 * The native app builds each scene from its `src` with its own loaders, and
 * physics from the physics components in it; poses of what it simulates reach
 * JavaScript through the `interactions` slice as before. Scenes and nodes
 * cross as the app's own string keys. Hidden, for a scene or a node, means
 * neither rendered nor hit-testable.
 */
export interface NativeScenesHost {
  /**
   * Build a scene, shown or hidden. Reject when it cannot be built, leaving
   * nothing behind. Report every node's id, repeats included: the manager
   * fails a load whose ids repeat (and destroys what was built), exactly as
   * over IWSDK's port. Hidden means neither rendered nor hit-testable, as
   * IWSDK hides a scene three ways (visibility, raycast layers, pointer
   * events).
   */
  build(def: SceneDefinition, visible: boolean): Promise<NativeBuiltScene>;
  /** Show or hide a built scene without rebuilding it. */
  setVisible(scene: string, visible: boolean): void;
  /** Remove a scene and everything still in it. */
  destroy(scene: string): void;
  /** Turn a node, and everything under it, on or off. */
  setNodeActive(node: string, active: boolean): void;
  /** Spawn a named asset at a world pose, in a scene, under an optional parent node. Returns its key. */
  instantiate(asset: string, pose: WorldPose, scene: string, parent: string | null): string;
  destroyInstance(instance: string): void;
  /** Move a node out of its scene's lifetime, keeping its world pose and visibility. */
  detachNode(scene: string, node: string): void;
  /** Remove a node `detachNode` moved out. */
  destroyNode(node: string): void;
  /** Build progress for a scene id, 0 to 1. Optional. */
  onBuildProgress?(callback: (sceneId: string, progress: number) => void): () => void;
}

/** The root of `globalThis.__rcHost`, as far as this package ever reads it. */
interface NativeHostRoot {
  readonly environment?: NativeEnvironmentHost;
  readonly audio?: NativeAudioHost;
  readonly sensing?: NativeSensingHost;
  readonly scenes?: NativeScenesHost;
}

function globalHost(): NativeHostRoot | undefined {
  return (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] as NativeHostRoot | undefined;
}

function missingSlice(name: "environment" | "audio" | "scenes"): Error {
  return new Error(
    `[native-environment] no ${name} host: globalThis.${NATIVE_HOST_GLOBAL}.${name} is not installed. ` +
      `Either pass a ${name} host in directly, or have the native app install it before the bundle is evaluated.`,
  );
}

/**
 * The environment slice: the one passed in, or `globalThis.__rcHost.environment`.
 * Throws when neither has one, because `NativeEnvironmentPort` cannot be built
 * without it and the point of throwing here, once, is that it never fails
 * later in a way that is harder to place.
 */
export function getEnvironmentHost(host?: NativeEnvironmentHost): NativeEnvironmentHost {
  const found = host ?? globalHost()?.environment;
  if (found === undefined) throw missingSlice("environment");
  return found;
}

/** The audio slice: the one passed in, or `globalThis.__rcHost.audio`. Throws when neither has one. */
export function getAudioHost(host?: NativeAudioHost): NativeAudioHost {
  const found = host ?? globalHost()?.audio;
  if (found === undefined) throw missingSlice("audio");
  return found;
}

/**
 * The sensing slice: the one passed in, or `globalThis.__rcHost.sensing`, or
 * `undefined` when neither has one. Never throws - `sensing` is the one slice
 * this family treats as genuinely optional, and `NativeWorldSensingPort`
 * reports `unsupported` rather than refusing to exist.
 */
export function getSensingHost(host?: NativeSensingHost): NativeSensingHost | undefined {
  return host ?? globalHost()?.sensing;
}

/** The scenes slice: the one passed in, or `globalThis.__rcHost.scenes`. Throws when neither has one. */
export function getScenesHost(host?: NativeScenesHost): NativeScenesHost {
  const found = host ?? globalHost()?.scenes;
  if (found === undefined) throw missingSlice("scenes");
  return found;
}
