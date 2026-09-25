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
  applySky(sky: SkySpec | null): void;
  applyFog(fog: FogSpec | null): void;
  applyAmbient(light: AmbientLightSpec | null): void;
  applyKeyLight(light: KeyLightSpec | null): void;
  applyIbl(ibl: IblSpec | null): void;
  applyOcclusion?(spec: OcclusionSpec | null): void;
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
  load?(cue: AudioCue): void | Promise<unknown>;
  start(request: NativeAudioVoiceRequest): void;
  stop(voiceId: number): void;
  setGain?(voiceId: number, gain: number): void;
  /** The host retired a voice of its own accord - it finished, or failed to start. */
  onVoiceEnded(callback: (voiceId: number) => void): () => void;
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
  setDetection?(detection: ResolvedWorldDetection | null): void;
  startHitTest?(request: HitTestRequest): void;
  stopHitTest?(id: string): void;
  createAnchor?(pose: WorldPose): Promise<string | null>;
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
  /** Build a scene, shown or hidden. Reject when it cannot be built, leaving nothing behind. */
  build(def: SceneDefinition, visible: boolean): Promise<NativeBuiltScene>;
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
