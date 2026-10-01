/**
 * Scene management: the vocabulary and the port.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS IN THE CORE
 * ---------------------------------------------------------------------------
 * A WebXR app cannot change scene by changing page, because navigating ends
 * the immersive session. So every app with more than one scene already
 * manages scenes inside one session, and each host does it differently: IWSDK
 * has levels and `persistent` entities, three.js and XR Blocks build and
 * dispose object graphs, and a native host has no engine in JavaScript at
 * all. The meaning is the same everywhere; the mechanics differ. The rules
 * (the list, the stack, the active scene, persistence and the events) live in
 * `SceneManager`, and each host implements {@link ScenePort} to build and
 * destroy the content.
 *
 * ---------------------------------------------------------------------------
 * WHAT STAYS OUT
 * ---------------------------------------------------------------------------
 * How a scene looks (materials, opacity, animation) is presentation, which the
 * app builds per host. The file format behind `src` is the app's asset
 * pipeline: a `src` means the same thing on every host, and each host resolves
 * it with its own loaders. Physics and grab components in a scene are data the
 * host maps onto its own engine; this package carries none of it.
 */
import type { EnvironmentSpec } from "./environment.js";
import type { WorldPose } from "./world-sensing.js";

/** One entry in the scene list. */
export interface SceneDefinition {
  /** Unique within the list. {@link PERSISTENT_SCENE_ID} is reserved. */
  readonly id: string;
  /**
   * What to build. Resolved by the host's own loader, and means the same thing
   * on every host: a URL, or a path relative to the app's content root.
   */
  readonly src: string;
  /**
   * The environment this scene asks for while it is the active scene: a spec,
   * or the name of a preset the director knows. Applied through the director
   * with a transition, exactly as a preset change is. A scene without one
   * leaves the environment as it is.
   */
  readonly environment?: EnvironmentSpec | string;
}

/** `"single"` replaces everything loaded; `"additive"` adds to the top of the stack. */
export type SceneLoadMode = "single" | "additive";

export interface SceneLoadOptions {
  /** Default `"single"`. */
  readonly mode?: SceneLoadMode;
  /**
   * Default `true`. `false` preloads: the scene is fully built but neither
   * shown nor hit-testable until `activate`. A single load that is preloaded
   * leaves the other scenes in place until it is activated, so the old scene
   * can play on while the new one builds behind it.
   */
  readonly activate?: boolean;
  /**
   * Default `true` for a single load and `false` for an additive one. A shown
   * scene always becomes active when no scene is, so there is never a shown
   * scene and no active one.
   */
  readonly makeActive?: boolean;
  /** 0 to 1, the host's best estimate. Always ends at exactly 1 on success. */
  readonly onProgress?: (progress: number) => void;
}

/**
 * Where a scene is in its life.
 *
 * - `"loading"`: the host is building it.
 * - `"preloaded"`: built, but neither shown nor hit-testable until `activate`.
 * - `"loaded"`: built and shown.
 */
export type LoadedSceneState = "loading" | "preloaded" | "loaded";

/** One entry in the scene stack. */
export interface LoadedScene {
  readonly id: string;
  readonly state: LoadedSceneState;
  /** Position in the stack, bottom first, from 0. */
  readonly order: number;
}

/** Where to put a new instance, and what to call it. */
export interface InstantiateOptions {
  /** Default: the active scene. */
  readonly scene?: string;
  /** A node in that scene to parent the instance to. The pose stays in world space. */
  readonly parentNode?: string;
  /**
   * The instance's id. Default: generated. It must be unused by every other
   * instance and by every node in the target scene, because an instance is
   * addressed as a node of the scene it was spawned into.
   */
  readonly id?: string;
}

/**
 * The scene id that persistent nodes are addressed under once they have left
 * their own scene, the way Unity moves a `DontDestroyOnLoad` object into a
 * scene of its own. Reserved: a scene definition may not use it.
 */
export const PERSISTENT_SCENE_ID = "@persistent";

/**
 * Builds and destroys scene content on one host.
 *
 * `S` is the host's handle for a built scene and `N` its handle for a node in
 * one (an `Object3D`, an entity, or a native app's own node key). The core
 * holds them and hands them back; it never looks inside.
 *
 * A translator, never a decision maker: the manager has already decided the
 * order, what survives a single load and which scene is active by the time a
 * method here is called. Every method is called at most once per handle for
 * the destructive ones (`destroy`, `destroyInstance`, `destroyNode`), and
 * never with a handle this port did not hand out.
 */
export interface ScenePort<S = unknown, N = unknown> {
  /**
   * Build a scene from its `src` with the host's own loaders. When `visible`
   * is false the scene must be fully built but neither rendered nor
   * hit-testable. Reject when the content cannot be built; the manager then
   * reports the load as failed, and a port that rejects must leave nothing
   * behind.
   */
  build(def: SceneDefinition, visible: boolean, onProgress: (progress: number) => void): Promise<S>;
  /** Show or hide a built scene. Hidden means not rendered and not hit-testable. */
  setVisible(scene: S, visible: boolean): void;
  /** Remove a scene and everything still in it. Detached nodes are not in it any more. */
  destroy(scene: S): void;
  /** The ids of the scene's addressable nodes. The manager rejects a scene that repeats one. */
  nodeIds(scene: S): readonly string[];
  /** The node with this id in the scene, or `null`. */
  findNode(scene: S, nodeId: string): N | null;
  /** Turn one node, and everything under it, on or off. Off means not rendered and not hit-testable. */
  setNodeActive(node: N, active: boolean): void;
  /**
   * Create an instance of a named asset in a scene, at a world pose, under an
   * optional parent node. The host resolves the name with its own loaders and
   * may fill the content in asynchronously; the handle is valid at once.
   */
  instantiate(asset: string, pose: WorldPose, scene: S, parent: N | null): N;
  /** Remove an instance made by `instantiate`. */
  destroyInstance(instance: N): void;
  /**
   * Move a node out of its scene's lifetime, keeping its world pose and its
   * visibility, so destroying the scene no longer takes it. Unity's
   * `DontDestroyOnLoad`.
   */
  detachNode(scene: S, node: N): void;
  /** Remove a node that `detachNode` moved out. */
  destroyNode(node: N): void;
  /** Release anything the port itself created. Optional. */
  dispose?(): void;
}
