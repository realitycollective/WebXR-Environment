/**
 * The scene manager: the scene list, the stack, the active scene, persistence
 * and the lifecycle events. A {@link ScenePort} builds and destroys the
 * content; every rule lives here, so it holds the same way on every host.
 *
 * ---------------------------------------------------------------------------
 * THE RULES
 * ---------------------------------------------------------------------------
 * - Single load: unloads every loaded scene, keeping persistent nodes, then
 *   loads. Unloaded events fire before the loaded event. A preloaded single
 *   load defers the unloading to `activate`.
 * - Additive load: adds to the top of the stack and changes nothing else.
 * - Unload: removes any scene in the stack, not only the top. The rest keep
 *   their order. Instances spawned into the scene go with it; persistent
 *   nodes do not.
 * - Active scene: at most one. `instantiate` puts new objects there when no
 *   scene is named, and its `environment` drives the director. Unloading it
 *   makes the top shown scene active, or none.
 * - Preload: `activate: false` builds a scene that is neither shown nor
 *   hit-testable until `activate`.
 * - Ordering: loads and unloads run one at a time, in call order. A second
 *   load of a scene already loaded or loading returns the same promise. A load
 *   of an id that is not in the list rejects.
 * - Node ids are unique within a scene; a scene that repeats one fails to
 *   load. A node bound with `bindNode` resolves to the host's node. The
 *   binding is live while the node's scene is shown and is released when the
 *   scene unloads.
 * - `dispose` leaves nothing on the host: no scenes, instances, persistent
 *   nodes, bindings, listeners or environment overrides.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT OWN A LOOP
 * ---------------------------------------------------------------------------
 * Nothing here ticks. The environment director it drives is ticked by the
 * host as before; loading is whatever the port's promises do.
 */
import type { EnvironmentDirector, TransitionOptions } from "./environment-director.js";
import type { ResolvedEnvironment } from "./environment.js";
import type { WorldPose } from "./world-sensing.js";
import type {
  InstantiateOptions,
  LoadedScene,
  LoadedSceneState,
  SceneDefinition,
  SceneLoadMode,
  SceneLoadOptions,
  ScenePort,
} from "./scenes.js";
import { PERSISTENT_SCENE_ID } from "./scenes.js";

export interface SceneManagerOptions {
  /**
   * The director the active scene's `environment` drives. Optional: a manager
   * without one manages content only.
   */
  readonly environment?: EnvironmentDirector;
  /** How the environment moves when the active scene changes. Default: the director's own default. */
  readonly transition?: TransitionOptions;
}

/** Called with a node when it is bound; returns what to call when the binding is released. */
export type SceneNodeBinder<N> = (node: N) => (() => void) | void;

interface Binding<N> {
  readonly node: N;
  readonly bind: SceneNodeBinder<N>;
  /** `true` while `bind` has run and its release has not. */
  bound: boolean;
  release: (() => void) | null;
}

/** The node bindings one owner (a scene, or the persistent set) is holding, by node id. */
type Bindings<N> = Map<string, Set<Binding<N>>>;

interface Entry<S, N> {
  readonly def: SceneDefinition;
  readonly mode: SceneLoadMode;
  readonly makeActive: boolean;
  state: LoadedSceneState;
  handle: S | null;
  /** Instances spawned into this scene, by id. */
  readonly instances: Map<string, N>;
  /** Node ids that `makePersistent` moved out of this scene. */
  readonly detached: Set<string>;
  readonly bindings: Bindings<N>;
  /** Set when the scene must go before its build finishes. */
  discarded: boolean;
  /** Identifies the `load` call that made this entry, in `#loads`. */
  readonly token: object;
}

interface PersistentNode<N> {
  readonly node: N;
  /** `true` for a persistent instance, so `destroy(id)` can find it. */
  readonly instance: boolean;
}

/** Only ever called for a binding that has not run: a new one, or one waiting on `activate`. */
function bindNow<N>(binding: Binding<N>, errors: unknown[]): void {
  binding.bound = true;
  try {
    const release = binding.bind(binding.node);
    binding.release = typeof release === "function" ? release : null;
  } catch (error) {
    errors.push(error);
  }
}

function unbind<N>(binding: Binding<N>, errors: unknown[]): void {
  const release = binding.bound ? binding.release : null;
  binding.bound = false;
  binding.release = null;
  if (release === null) return;
  try {
    release();
  } catch (error) {
    errors.push(error);
  }
}

function releaseAll<N>(bindings: Set<Binding<N>> | undefined, errors: unknown[]): void {
  if (bindings === undefined) return;
  for (const binding of bindings) unbind(binding, errors);
  bindings.clear();
}

function throwFirst(errors: readonly unknown[]): void {
  if (errors.length > 0) throw errors[0];
}

function clamp01(value: number): number {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

export class SceneManager<S = unknown, N = unknown> {
  readonly #port: ScenePort<S, N>;
  readonly #director: EnvironmentDirector | undefined;
  readonly #transition: TransitionOptions | undefined;
  readonly #defs = new Map<string, SceneDefinition>();
  /** Bottom first. */
  readonly #stack: Entry<S, N>[] = [];
  /** The promise a repeat `load` hands back, from the call until the scene is unloaded. */
  readonly #loads = new Map<string, { readonly promise: Promise<void>; readonly token: object }>();
  /** Every live instance id, and the scene it was spawned into. */
  readonly #instances = new Map<string, Entry<S, N>>();
  readonly #persistent = new Map<string, PersistentNode<N>>();
  readonly #persistentBindings: Bindings<N> = new Map();
  readonly #loadedListeners = new Set<(id: string) => void>();
  readonly #unloadedListeners = new Set<(id: string) => void>();
  readonly #activeListeners = new Set<(from: string | null, to: string | null) => void>();
  #queue: Promise<void> = Promise.resolve();
  #active: Entry<S, N> | null = null;
  /** What the director held before a scene first drove it; restored on dispose. */
  #environmentBase: ResolvedEnvironment | null = null;
  #nextInstance = 1;
  #disposed = false;

  constructor(port: ScenePort<S, N>, options: SceneManagerOptions = {}) {
    this.#port = port;
    this.#director = options.environment;
    this.#transition = options.transition;
  }

  /** Add scenes to the list. Throws on a repeated or reserved id. */
  register(defs: readonly SceneDefinition[]): void {
    this.#assertLive();
    for (const def of defs) {
      if (def.id === PERSISTENT_SCENE_ID) {
        throw new Error(`[webxr-environment] "${PERSISTENT_SCENE_ID}" is reserved for persistent nodes`);
      }
      if (this.#defs.has(def.id)) {
        throw new Error(`[webxr-environment] scene "${def.id}" is already in the list`);
      }
    }
    for (const def of defs) this.#defs.set(def.id, def);
  }

  /** The scene list, in registration order. */
  list(): readonly SceneDefinition[] {
    return [...this.#defs.values()];
  }

  /**
   * Load a scene from the list. See the file comment for the rules. Rejects
   * for an id that is not in the list, when the host cannot build the scene,
   * and when the scene repeats a node id.
   */
  load(id: string, options: SceneLoadOptions = {}): Promise<void> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    const def = this.#defs.get(id);
    if (def === undefined) {
      return Promise.reject(new Error(`[webxr-environment] scene "${id}" is not in the scene list`));
    }
    const pending = this.#loads.get(id);
    if (pending !== undefined) return pending.promise;
    const token = {};
    const promise = this.#enqueue(() => this.#runLoad(def, options, token));
    // Every way this load can fail drops its entry from `#loads` (see `#drop`),
    // so a later call starts a new load.
    this.#loads.set(id, { promise, token });
    return promise;
  }

  /**
   * Show a preloaded scene. A no-op for a scene already shown. Throws for a
   * scene that is not built. Activating a preloaded single load unloads every
   * other scene first, keeping persistent nodes.
   */
  activate(id: string): void {
    this.#assertLive();
    const entry = this.#find(id);
    if (entry === undefined || entry.state === "loading") {
      throw new Error(`[webxr-environment] scene "${id}" is not built, so it cannot be activated`);
    }
    if (entry.state === "loaded") return;
    const previous = this.#active;
    const errors: unknown[] = [];
    if (entry.mode === "single") {
      for (const other of [...this.#stack].reverse()) {
        if (other !== entry) this.#removeEntry(other, false, errors);
      }
      this.#active = null;
    }
    this.#port.setVisible(entry.handle as S, true);
    entry.state = "loaded";
    for (const bindings of entry.bindings.values()) {
      for (const binding of bindings) bindNow(binding, errors);
    }
    if (entry.mode === "single" || entry.makeActive || this.#active === null) {
      this.#setActive(entry, previous);
    }
    throwFirst(errors);
  }

  /**
   * Unload any scene in the stack. Runs after every load and unload called
   * before it. Resolves without doing anything for a scene that is not loaded
   * by then; rejects for an id that is not in the list.
   */
  unload(id: string): Promise<void> {
    if (this.#disposed) return Promise.reject(this.#disposedError());
    if (!this.#defs.has(id)) {
      return Promise.reject(new Error(`[webxr-environment] scene "${id}" is not in the scene list`));
    }
    // A load called after this one is a new load, not the one being unloaded.
    this.#loads.delete(id);
    return this.#enqueue(async () => {
      const entry = this.#find(id);
      if (entry === undefined) return;
      const errors: unknown[] = [];
      this.#removeEntry(entry, true, errors);
      throwFirst(errors);
    });
  }

  /** The stack, bottom first, loading scenes included. */
  loaded(): readonly LoadedScene[] {
    return this.#stack.map((entry, order) => ({ id: entry.def.id, state: entry.state, order }));
  }

  /** `true` once a scene is built, shown or preloaded, until it is unloaded. */
  isLoaded(id: string): boolean {
    const entry = this.#find(id);
    return entry !== undefined && entry.state !== "loading";
  }

  getActiveScene(): string | null {
    return this.#active?.def.id ?? null;
  }

  /** Make a shown scene the active one. Throws for a scene that is not shown. */
  setActiveScene(id: string): void {
    this.#assertLive();
    const entry = this.#find(id);
    if (entry === undefined || entry.state !== "loaded") {
      throw new Error(`[webxr-environment] scene "${id}" is not loaded and shown, so it cannot be active`);
    }
    this.#setActive(entry, this.#active);
  }

  /**
   * The host's node for an id in a scene - an instance id counts as a node of
   * the scene it was spawned into - or `null`. Use {@link PERSISTENT_SCENE_ID}
   * for a node made persistent.
   */
  getNode(sceneId: string, nodeId: string): N | null {
    if (this.#disposed) return null;
    return this.#resolve(sceneId, nodeId)?.node ?? null;
  }

  /** Turn a node on or off. Throws for a node that cannot be found. */
  setNodeActive(sceneId: string, nodeId: string, active: boolean): void {
    this.#assertLive();
    this.#port.setNodeActive(this.#require(sceneId, nodeId).node, active);
  }

  /**
   * Tie something to a node's lifetime while its scene is shown, such as an
   * interaction target registered against it. `bind` runs with the host's
   * node now, or when a preloaded scene is activated; what it returns runs
   * once, when the node's scene unloads, when the node is destroyed, when the
   * manager is disposed, or when the returned function is called, whichever
   * comes first. A node made persistent keeps its bindings.
   *
   * Binding only while shown is what keeps a preloaded scene's targets out of
   * hit testing on every host: some hosts' hit testers test registered
   * objects directly and never look at whether they are shown.
   */
  bindNode(sceneId: string, nodeId: string, bind: SceneNodeBinder<N>): () => void {
    this.#assertLive();
    const found = this.#require(sceneId, nodeId);
    const binding: Binding<N> = { node: found.node, bind, bound: false, release: null };
    let set = found.bindings.get(found.id);
    if (set === undefined) {
      set = new Set();
      found.bindings.set(found.id, set);
    }
    set.add(binding);
    const errors: unknown[] = [];
    if (found.entry === null || found.entry.state === "loaded") bindNow(binding, errors);
    throwFirst(errors);
    const owner = set;
    return () => {
      owner.delete(binding);
      const released: unknown[] = [];
      unbind(binding, released);
      throwFirst(released);
    };
  }

  /**
   * Spawn a named asset at a world pose. Goes into the active scene unless
   * `options.scene` names another built scene. Returns the instance id, which
   * also addresses it as a node of that scene.
   */
  instantiate(asset: string, pose: WorldPose, options: InstantiateOptions = {}): string {
    this.#assertLive();
    const sceneId = options.scene ?? this.#active?.def.id;
    if (sceneId === undefined) {
      throw new Error("[webxr-environment] no scene is active, so instantiate needs options.scene");
    }
    const entry = this.#find(sceneId);
    if (entry === undefined || entry.handle === null || entry.discarded) {
      throw new Error(`[webxr-environment] scene "${sceneId}" is not built, so nothing can be spawned into it`);
    }
    const parent =
      options.parentNode === undefined ? null : this.#require(sceneId, options.parentNode).node;
    let id = options.id;
    if (id === undefined) {
      do {
        id = `${asset}#${String(this.#nextInstance)}`;
        this.#nextInstance += 1;
      } while (this.#idTaken(entry, id));
    } else if (this.#idTaken(entry, id)) {
      throw new Error(`[webxr-environment] "${id}" is already an instance or a node in scene "${sceneId}"`);
    }
    const node = this.#port.instantiate(asset, pose, entry.handle, parent);
    entry.instances.set(id, node);
    this.#instances.set(id, entry);
    return id;
  }

  /** Remove an instance, persistent or not. A no-op for an unknown id. */
  destroy(instanceId: string): void {
    this.#assertLive();
    const errors: unknown[] = [];
    const entry = this.#instances.get(instanceId);
    if (entry !== undefined) {
      const node = entry.instances.get(instanceId) as N;
      releaseAll(entry.bindings.get(instanceId), errors);
      entry.bindings.delete(instanceId);
      entry.instances.delete(instanceId);
      this.#instances.delete(instanceId);
      this.#port.destroyInstance(node);
    } else {
      const persistent = this.#persistent.get(instanceId);
      if (persistent === undefined || !persistent.instance) return;
      releaseAll(this.#persistentBindings.get(instanceId), errors);
      this.#persistentBindings.delete(instanceId);
      this.#persistent.delete(instanceId);
      this.#port.destroyNode(persistent.node);
    }
    throwFirst(errors);
  }

  /**
   * Take a node, or an instance, out of its scene's lifetime so it survives
   * single loads and the scene's unload - Unity's `DontDestroyOnLoad`. From
   * then on it is addressed as (`PERSISTENT_SCENE_ID`, `nodeId`), so its id
   * must not already be persistent. It lives until `dispose`, or `destroy`
   * for an instance.
   */
  makePersistent(sceneId: string, nodeId: string): void {
    this.#assertLive();
    if (sceneId === PERSISTENT_SCENE_ID) return;
    const found = this.#require(sceneId, nodeId);
    if (this.#persistent.has(nodeId)) {
      throw new Error(`[webxr-environment] a persistent node "${nodeId}" already exists`);
    }
    const entry = found.entry as Entry<S, N>;
    this.#port.detachNode(entry.handle as S, found.node);
    const instance = entry.instances.delete(nodeId);
    if (instance) this.#instances.delete(nodeId);
    else entry.detached.add(nodeId);
    this.#persistent.set(nodeId, { node: found.node, instance });
    const bindings = entry.bindings.get(nodeId);
    if (bindings !== undefined) {
      entry.bindings.delete(nodeId);
      this.#persistentBindings.set(nodeId, bindings);
      // A persistent node is always shown, so a binding still waiting on a
      // preloaded scene's activate runs now.
      if (entry.state !== "loaded") {
        const errors: unknown[] = [];
        for (const binding of bindings) bindNow(binding, errors);
        throwFirst(errors);
      }
    }
  }

  onSceneLoaded(callback: (id: string) => void): () => void {
    return this.#subscribe(this.#loadedListeners, callback);
  }

  onSceneUnloaded(callback: (id: string) => void): () => void {
    return this.#subscribe(this.#unloadedListeners, callback);
  }

  onActiveSceneChanged(callback: (from: string | null, to: string | null) => void): () => void {
    return this.#subscribe(this.#activeListeners, callback);
  }

  /**
   * Remove everything this manager put on the host and restore the
   * environment a scene first overrode. Fires no events. Loads still queued
   * or building reject. Dispose this before the environment director.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadedListeners.clear();
    this.#unloadedListeners.clear();
    this.#activeListeners.clear();
    const errors: unknown[] = [];
    for (const entry of [...this.#stack].reverse()) this.#teardown(entry, errors);
    this.#stack.length = 0;
    for (const [id, persistent] of this.#persistent) {
      releaseAll(this.#persistentBindings.get(id), errors);
      this.#port.destroyNode(persistent.node);
    }
    this.#persistent.clear();
    this.#persistentBindings.clear();
    this.#instances.clear();
    this.#loads.clear();
    this.#active = null;
    const base = this.#environmentBase;
    this.#environmentBase = null;
    if (base !== null && this.#director !== undefined) {
      try {
        this.#director.apply(base);
      } catch {
        // The director was disposed first, so there is nothing left to restore.
      }
    }
    this.#port.dispose?.();
    throwFirst(errors);
  }

  // -------------------------------------------------------------------------

  async #runLoad(def: SceneDefinition, options: SceneLoadOptions, token: object): Promise<void> {
    if (this.#disposed) throw this.#disposedError();
    const mode = options.mode ?? "single";
    const show = options.activate ?? true;
    const entry: Entry<S, N> = {
      def,
      mode,
      makeActive: options.makeActive ?? mode === "single",
      state: "loading",
      handle: null,
      instances: new Map(),
      detached: new Set(),
      bindings: new Map(),
      discarded: false,
      token,
    };

    const previous = this.#active;
    const errors: unknown[] = [];
    const replacing = mode === "single" && show;
    if (replacing) {
      for (const other of [...this.#stack].reverse()) this.#removeEntry(other, false, errors);
      this.#active = null;
    }
    this.#stack.push(entry);

    const onProgress = options.onProgress;
    const progress = (value: number) => {
      if (!entry.discarded && !this.#disposed) onProgress?.(clamp01(value));
    };

    let handle: S;
    try {
      handle = await this.#port.build(def, show, progress);
    } catch (error) {
      this.#drop(entry);
      if (replacing && previous !== null) this.#setActive(null, previous);
      throw error;
    }
    if (entry.discarded || this.#disposed) {
      this.#port.destroy(handle);
      this.#drop(entry);
      throw new Error(`[webxr-environment] scene "${def.id}" was removed before it finished loading`);
    }
    const repeated = firstRepeat(this.#port.nodeIds(handle));
    if (repeated !== null) {
      this.#port.destroy(handle);
      this.#drop(entry);
      if (replacing && previous !== null) this.#setActive(null, previous);
      throw new Error(`[webxr-environment] scene "${def.id}" repeats the node id "${repeated}"`);
    }

    entry.handle = handle;
    entry.state = show ? "loaded" : "preloaded";
    onProgress?.(1);
    for (const listener of [...this.#loadedListeners]) listener(def.id);
    if (show && (entry.makeActive || replacing || this.#active === null)) {
      this.#setActive(entry, replacing ? previous : this.#active);
    }
    throwFirst(errors);
  }

  /** Take a scene off the host and out of the stack, with its unloaded event. */
  #removeEntry(entry: Entry<S, N>, reassignActive: boolean, errors: unknown[]): void {
    if (entry.state === "loading") {
      // Its build finishes in `#runLoad`, which sees the flag and destroys it.
      entry.discarded = true;
      this.#drop(entry);
      return;
    }
    this.#teardown(entry, errors);
    this.#drop(entry);
    for (const listener of [...this.#unloadedListeners]) listener(entry.def.id);
    if (this.#active === entry) {
      if (reassignActive) this.#setActive(this.#topShown(), entry);
      else this.#active = null;
    }
  }

  /** Release bindings, destroy instances and the scene. Leaves the stack alone. */
  #teardown(entry: Entry<S, N>, errors: unknown[]): void {
    entry.discarded = true;
    for (const bindings of entry.bindings.values()) releaseAll(bindings, errors);
    entry.bindings.clear();
    for (const [id, node] of entry.instances) {
      this.#instances.delete(id);
      this.#port.destroyInstance(node);
    }
    entry.instances.clear();
    if (entry.handle !== null) this.#port.destroy(entry.handle);
    entry.handle = null;
  }

  #drop(entry: Entry<S, N>): void {
    const index = this.#stack.indexOf(entry);
    if (index >= 0) this.#stack.splice(index, 1);
    if (this.#loads.get(entry.def.id)?.token === entry.token) this.#loads.delete(entry.def.id);
  }

  #setActive(entry: Entry<S, N> | null, from: Entry<S, N> | null): void {
    this.#active = entry;
    if (entry === from) return;
    const environment = entry?.def.environment;
    if (environment !== undefined && this.#director !== undefined) {
      this.#environmentBase ??= this.#director.current;
      this.#director.transition(environment, this.#transition);
    }
    const fromId = from?.def.id ?? null;
    const toId = entry?.def.id ?? null;
    for (const listener of [...this.#activeListeners]) listener(fromId, toId);
  }

  #topShown(): Entry<S, N> | null {
    for (let index = this.#stack.length - 1; index >= 0; index -= 1) {
      const entry = this.#stack[index] as Entry<S, N>;
      if (entry.state === "loaded") return entry;
    }
    return null;
  }

  #find(id: string): Entry<S, N> | undefined {
    return this.#stack.find((entry) => entry.def.id === id && !entry.discarded);
  }

  #idTaken(entry: Entry<S, N>, id: string): boolean {
    return (
      this.#instances.has(id) ||
      this.#persistent.has(id) ||
      entry.detached.has(id) ||
      this.#port.findNode(entry.handle as S, id) !== null
    );
  }

  #resolve(
    sceneId: string,
    nodeId: string,
  ): { node: N; id: string; entry: Entry<S, N> | null; bindings: Bindings<N> } | null {
    if (sceneId === PERSISTENT_SCENE_ID) {
      const persistent = this.#persistent.get(nodeId);
      if (persistent === undefined) return null;
      return { node: persistent.node, id: nodeId, entry: null, bindings: this.#persistentBindings };
    }
    const entry = this.#find(sceneId);
    if (entry === undefined || entry.handle === null || entry.detached.has(nodeId)) return null;
    const node = entry.instances.get(nodeId) ?? this.#port.findNode(entry.handle, nodeId);
    if (node === null || node === undefined) return null;
    return { node, id: nodeId, entry, bindings: entry.bindings };
  }

  #require(sceneId: string, nodeId: string): { node: N; id: string; entry: Entry<S, N> | null; bindings: Bindings<N> } {
    const found = this.#resolve(sceneId, nodeId);
    if (found === null) {
      throw new Error(`[webxr-environment] no node "${nodeId}" in scene "${sceneId}"`);
    }
    return found;
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.#queue.then(operation);
    this.#queue = run.catch(() => {});
    return run;
  }

  #subscribe<T>(listeners: Set<T>, callback: T): () => void {
    if (this.#disposed) return () => {};
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
    };
  }

  #disposedError(): Error {
    return new Error("[webxr-environment] the scene manager has been disposed");
  }

  #assertLive(): void {
    if (this.#disposed) throw this.#disposedError();
  }
}

function firstRepeat(ids: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}
