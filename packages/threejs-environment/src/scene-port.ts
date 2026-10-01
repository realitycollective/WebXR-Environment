/**
 * `ScenePort` for three.js. Also the XR Blocks port, since XR Blocks renders
 * through a three.js scene.
 *
 * ---------------------------------------------------------------------------
 * A SCENE IS A GROUP UNDER THE ROOT
 * ---------------------------------------------------------------------------
 * Each loaded scene is one `Group` under the root this port was given, with
 * the loaded content inside it. Its nodes are the objects in that content that
 * carry an id: `userData.nodeId` when the loader set one, otherwise the
 * object's `name`. `GLTFLoader` makes node names unique within a file, which
 * is what the manager's unique-id rule needs.
 *
 * ---------------------------------------------------------------------------
 * HIDDEN MEANS NOT RENDERED AND NOT HIT-TESTABLE
 * ---------------------------------------------------------------------------
 * A preloaded scene, or a node turned off, stays in the graph so it is built
 * and keeps its place. What hides it is three things, set on every object in
 * the subtree and restored on the way back:
 *
 * - `visible = false`, which three.js's renderer inherits down the tree.
 * - An empty layer mask, because `Raycaster` tests each object's layers and
 *   ignores `visible`. Every raycaster on the default layer then passes it
 *   by, the Interactions hit tester's included.
 * - `pointerEvents = "none"`, because the pmndrs pointer events that uikit
 *   and IWSDK use call `raycast` directly and read only that property.
 */
import type { Object3D } from "three";
import { Group, Matrix4, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { SceneDefinition, ScenePort, WorldPose } from "@realitycollective/webxr-environment";

/** Builds a scene's content from its definition. Resolve with the root of what was built. */
export type ThreeSceneLoader = (
  def: SceneDefinition,
  onProgress: (progress: number) => void,
) => Promise<Object3D>;

/** Makes a fresh object for a named asset, for `instantiate`. */
export type ThreeAssetFactory = (asset: string) => Object3D;

export interface ThreeScenePortOptions {
  /** Default: `GLTFLoader`, with the loaded file's `scene` as the content. */
  readonly load?: ThreeSceneLoader;
  /**
   * Resolves an asset name for `instantiate`. three.js has no asset registry
   * of its own, so an app that spawns objects supplies one; without it
   * `instantiate` throws and says so.
   */
  readonly assets?: ThreeAssetFactory;
}

interface SceneIndex {
  readonly ids: string[];
  readonly nodes: Map<string, Object3D>;
}

/** `pointerEvents` is pmndrs's addition to `Object3D`; three.js itself does not declare it. */
type PointerTarget = Object3D & { pointerEvents?: unknown };

interface Saved {
  readonly mask: number;
  readonly pointerEvents: unknown;
}

function nodeIdOf(object: Object3D): string | null {
  const fromData = (object.userData as { nodeId?: unknown }).nodeId;
  if (typeof fromData === "string" && fromData !== "") return fromData;
  return object.name === "" ? null : object.name;
}

const defaultLoad: ThreeSceneLoader = async (def, onProgress) => {
  const gltf = await new GLTFLoader().loadAsync(def.src, (event) => {
    if (event.total > 0) onProgress(event.loaded / event.total);
  });
  return gltf.scene;
};

export class ThreeScenePort implements ScenePort<Group, Object3D> {
  readonly #root: Object3D;
  readonly #load: ThreeSceneLoader;
  readonly #assets: ThreeAssetFactory | undefined;
  readonly #index = new WeakMap<Group, SceneIndex>();
  /** Objects this port turned off: hidden scenes and inactive nodes. */
  readonly #off = new WeakSet<Object3D>();
  readonly #saved = new WeakMap<Object3D, Saved>();

  constructor(root: Object3D, options: ThreeScenePortOptions = {}) {
    this.#root = root;
    this.#load = options.load ?? defaultLoad;
    this.#assets = options.assets;
  }

  async build(def: SceneDefinition, visible: boolean, onProgress: (progress: number) => void): Promise<Group> {
    const content = await this.#load(def, onProgress);
    const group = new Group();
    group.name = `scene:${def.id}`;
    group.add(content);
    const index: SceneIndex = { ids: [], nodes: new Map() };
    content.traverse((object) => {
      const id = nodeIdOf(object);
      if (id === null) return;
      index.ids.push(id);
      if (!index.nodes.has(id)) index.nodes.set(id, object);
    });
    this.#index.set(group, index);
    if (!visible) this.#setOff(group, true);
    this.#root.add(group);
    return group;
  }

  setVisible(scene: Group, visible: boolean): void {
    this.#setOff(scene, !visible);
  }

  destroy(scene: Group): void {
    scene.removeFromParent();
    this.#index.delete(scene);
  }

  nodeIds(scene: Group): readonly string[] {
    return this.#index.get(scene)?.ids ?? [];
  }

  findNode(scene: Group, nodeId: string): Object3D | null {
    return this.#index.get(scene)?.nodes.get(nodeId) ?? null;
  }

  setNodeActive(node: Object3D, active: boolean): void {
    this.#setOff(node, !active);
  }

  instantiate(asset: string, pose: WorldPose, scene: Group, parent: Object3D | null): Object3D {
    if (this.#assets === undefined) {
      throw new Error(
        `[threejs-environment] cannot instantiate "${asset}": pass an assets factory to the scene port`,
      );
    }
    const object = this.#assets(asset);
    const target = parent ?? scene;
    target.updateWorldMatrix(true, false);
    const world = new Matrix4().compose(
      new Vector3(pose.position[0], pose.position[1], pose.position[2]),
      new Quaternion(pose.orientation[0], pose.orientation[1], pose.orientation[2], pose.orientation[3]),
      new Vector3(1, 1, 1),
    );
    world.premultiply(target.matrixWorld.clone().invert());
    world.decompose(object.position, object.quaternion, object.scale);
    target.add(object);
    this.#refresh(object);
    return object;
  }

  destroyInstance(instance: Object3D): void {
    instance.removeFromParent();
  }

  detachNode(scene: Group, node: Object3D): void {
    this.#root.attach(node);
    const index = this.#index.get(scene);
    if (index !== undefined) {
      for (const [id, found] of index.nodes) if (found === node) index.nodes.delete(id);
    }
    this.#refresh(node);
  }

  destroyNode(node: Object3D): void {
    node.removeFromParent();
  }

  #setOff(object: Object3D, off: boolean): void {
    if (off) this.#off.add(object);
    else this.#off.delete(object);
    object.visible = !off;
    this.#refresh(object);
  }

  /** Re-apply what the objects above and inside `object` say about hiding it. */
  #refresh(object: Object3D): void {
    let inherited = false;
    for (let at = object.parent; at !== null; at = at.parent) {
      if (this.#off.has(at)) {
        inherited = true;
        break;
      }
    }
    this.#visit(object, inherited);
  }

  #visit(object: Object3D, inherited: boolean): void {
    const off = inherited || this.#off.has(object);
    const target = object as PointerTarget;
    const saved = this.#saved.get(object);
    if (off && saved === undefined) {
      this.#saved.set(object, { mask: object.layers.mask, pointerEvents: target.pointerEvents });
      object.layers.mask = 0;
      target.pointerEvents = "none";
    } else if (!off && saved !== undefined) {
      this.#saved.delete(object);
      object.layers.mask = saved.mask;
      target.pointerEvents = saved.pointerEvents;
    }
    for (const child of object.children) this.#visit(child, off);
  }
}
