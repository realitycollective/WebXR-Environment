/**
 * `ScenePort` for IWSDK.
 *
 * ---------------------------------------------------------------------------
 * A SCENE IS AN ENTITY TREE BESIDE THE LEVEL, NOT A LEVEL
 * ---------------------------------------------------------------------------
 * IWSDK's `world.loadLevel` replaces the one active level, which is a single
 * load and nothing else. This port builds each scene under its own persistent
 * root entity with IWSDK's own `SceneJSONImporter`, the loader `loadLevel`
 * uses, so additive loads, a stack and preloading all work. The importer tags
 * what it creates with `LevelTag`; the port removes that tag, because a scene
 * this manager owns must not be destroyed by an unrelated `loadLevel`.
 *
 * Every entity the port creates is tracked per scene, because destroying an
 * entity in IWSDK does not destroy the entities parented under it.
 *
 * ---------------------------------------------------------------------------
 * HIDDEN MEANS NOT RENDERED AND NOT HIT-TESTABLE
 * ---------------------------------------------------------------------------
 * A transform entity cannot leave the graph - IWSDK's `TransformSystem`
 * re-parents it on the next frame - so hiding is done in place, as in the
 * three.js port: `visible` (which IWSDK routes into its `Visibility`
 * component), an empty layer mask for three.js raycasters, and
 * `pointerEvents = "none"` for the pmndrs pointer events IWSDK's input system
 * uses, which call `raycast` directly and read only that property.
 */
import type { Entity, World } from "@iwsdk/core";
import { AssetManager, LevelTag, SceneJSONImporter } from "@iwsdk/core";
import type { Object3D } from "three";
import { Group, Matrix4, Quaternion, Vector3 } from "three";
import type { SceneDefinition, ScenePort, WorldPose } from "@realitycollective/webxr-environment";

/** What a loader built: every node by id, each one an entity. */
export interface IWSDKSceneContent {
  readonly nodes: readonly { readonly id: string; readonly entity: Entity }[];
}

/**
 * Builds a scene's content under `parent`. Default: IWSDK's own
 * `SceneJSONImporter`, reading `src` as an `iwsdk.scene.v1` document.
 */
export type IWSDKSceneLoader = (
  def: SceneDefinition,
  parent: Entity,
  onProgress: (progress: number) => void,
) => Promise<IWSDKSceneContent>;

/** Makes a fresh object for a named asset, for `instantiate`. */
export type IWSDKAssetFactory = (asset: string) => Object3D;

export interface IWSDKScenePortOptions {
  readonly load?: IWSDKSceneLoader;
  /**
   * Resolves an asset name for `instantiate`. Default: a clone of the glTF
   * IWSDK's `AssetManager` holds under that key, which it has once the asset
   * is in the world's manifest and preloaded.
   */
  readonly assets?: IWSDKAssetFactory;
}

interface SceneRecord {
  readonly ids: string[];
  readonly nodes: Map<string, Entity>;
  /** Every entity this scene owns, root excluded. */
  readonly entities: Set<Entity>;
}

/** IWSDK types `pointerEvents` narrowly; the port only saves and restores it. */
interface PointerTarget {
  pointerEvents?: unknown;
}

interface Saved {
  readonly mask: number;
  readonly pointerEvents: unknown;
}

function isUnder(object: Object3D, ancestor: Object3D): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) if (at === ancestor) return true;
  return false;
}

function defaultAsset(asset: string): Object3D {
  const gltf = AssetManager.getGLTF(asset);
  if (gltf === null) {
    throw new Error(
      `[iwsdk-environment] cannot instantiate "${asset}": it is not a preloaded glTF in the asset manifest`,
    );
  }
  return gltf.scene.clone();
}

export class IWSDKScenePort implements ScenePort<Entity, Entity> {
  readonly #world: World;
  readonly #load: IWSDKSceneLoader;
  readonly #assets: IWSDKAssetFactory;
  readonly #scenes = new Map<Entity, SceneRecord>();
  /** Entities under a node that `detachNode` moved out, destroyed with it. */
  readonly #detached = new Map<Entity, Set<Entity>>();
  readonly #off = new WeakSet<Object3D>();
  readonly #saved = new WeakMap<Object3D, Saved>();

  constructor(world: World, options: IWSDKScenePortOptions = {}) {
    this.#world = world;
    this.#load =
      options.load ??
      (async (def, parent) => {
        const result = await SceneJSONImporter.load(world, def.src, parent);
        return { nodes: [...result.nodes.values()].map((node) => ({ id: node.nodeId, entity: node.entity })) };
      });
    this.#assets = options.assets ?? defaultAsset;
  }

  async build(def: SceneDefinition, visible: boolean, onProgress: (progress: number) => void): Promise<Entity> {
    const root = this.#world.createTransformEntity(new Group(), {
      parent: this.#world.sceneEntity,
      persistent: true,
    });
    (root.object3D as Object3D).name = `scene:${def.id}`;
    if (!visible) this.#setOff(root.object3D as Object3D, true);
    let content: IWSDKSceneContent;
    try {
      content = await this.#load(def, root, onProgress);
    } catch (error) {
      root.destroy();
      throw error;
    }
    const record: SceneRecord = { ids: [], nodes: new Map(), entities: new Set() };
    for (const { id, entity } of content.nodes) {
      if (entity.hasComponent(LevelTag)) entity.removeComponent(LevelTag);
      record.ids.push(id);
      record.entities.add(entity);
      if (!record.nodes.has(id)) record.nodes.set(id, entity);
    }
    this.#scenes.set(root, record);
    this.#refresh(root.object3D as Object3D);
    return root;
  }

  setVisible(scene: Entity, visible: boolean): void {
    this.#setOff(scene.object3D as Object3D, !visible);
  }

  destroy(scene: Entity): void {
    const record = this.#scenes.get(scene);
    this.#scenes.delete(scene);
    for (const entity of record?.entities ?? []) entity.destroy();
    scene.destroy();
  }

  nodeIds(scene: Entity): readonly string[] {
    return this.#scenes.get(scene)?.ids ?? [];
  }

  findNode(scene: Entity, nodeId: string): Entity | null {
    return this.#scenes.get(scene)?.nodes.get(nodeId) ?? null;
  }

  setNodeActive(node: Entity, active: boolean): void {
    this.#setOff(node.object3D as Object3D, !active);
  }

  instantiate(asset: string, pose: WorldPose, scene: Entity, parent: Entity | null): Entity {
    const object = this.#assets(asset);
    const target = parent ?? scene;
    const targetObject = target.object3D as Object3D;
    targetObject.updateWorldMatrix(true, false);
    const world = new Matrix4().compose(
      new Vector3(pose.position[0], pose.position[1], pose.position[2]),
      new Quaternion(pose.orientation[0], pose.orientation[1], pose.orientation[2], pose.orientation[3]),
      new Vector3(1, 1, 1),
    );
    world.premultiply(targetObject.matrixWorld.clone().invert());
    world.decompose(object.position, object.quaternion, object.scale);
    const entity = this.#world.createTransformEntity(object, { parent: target, persistent: true });
    this.#scenes.get(scene)?.entities.add(entity);
    this.#refresh(object);
    return entity;
  }

  destroyInstance(instance: Entity): void {
    for (const record of this.#scenes.values()) record.entities.delete(instance);
    instance.destroy();
  }

  detachNode(scene: Entity, node: Entity): void {
    const object = node.object3D as Object3D;
    (this.#world.sceneEntity.object3D as Object3D).attach(object);
    const owned = new Set<Entity>();
    const record = this.#scenes.get(scene);
    if (record !== undefined) {
      for (const entity of record.entities) {
        if (entity === node || (entity.object3D !== undefined && isUnder(entity.object3D, object))) {
          record.entities.delete(entity);
          if (entity !== node) owned.add(entity);
        }
      }
      for (const [id, found] of record.nodes) if (found === node) record.nodes.delete(id);
    }
    this.#detached.set(node, owned);
    this.#refresh(object);
  }

  destroyNode(node: Entity): void {
    for (const entity of this.#detached.get(node) ?? []) entity.destroy();
    this.#detached.delete(node);
    node.destroy();
  }

  #setOff(object: Object3D, off: boolean): void {
    if (off) this.#off.add(object);
    else this.#off.delete(object);
    object.visible = !off;
    this.#refresh(object);
  }

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
    const target = object as unknown as PointerTarget;
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
