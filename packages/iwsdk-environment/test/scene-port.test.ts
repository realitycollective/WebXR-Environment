/**
 * The scene management suite over the real `IWSDKScenePort`, on the fake
 * world from `helpers.ts` with real three.js objects under it. The fixture
 * loader creates entities through the world and tags them `LevelTag`, as
 * IWSDK's importer does. The inspector answers from the graph: an entity
 * exists while it is live and under `world.scene`, is shown when every object
 * above it is visible, and is hit-testable when a stock `Raycaster` finds it
 * and pmndrs pointer events would not skip it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetManager, LevelTag, SceneJSONImporter, type Entity } from "@iwsdk/core";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Raycaster, Vector3 } from "three";
import {
  createIWSDKScenes,
  IWSDKScenePort,
  sceneManagerContractCases,
  type SceneContractFixtures,
  type SceneContractHost,
  type Vec3,
} from "@realitycollective/iwsdk-environment";
import { asEntity, asWorld, createFakeWorld, type FakeEntity, type FakeWorld } from "./helpers.js";

const GEOMETRY = new BoxGeometry(0.2, 0.2, 0.2);
const MATERIAL = new MeshBasicMaterial();

function box(position: Vec3): Mesh {
  const mesh = new Mesh(GEOMETRY, MATERIAL);
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

function isUnder(object: Object3D, ancestor: Object3D): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) if (at === ancestor) return true;
  return false;
}

const fake = (entity: Entity) => entity as unknown as FakeEntity;

afterEach(() => {
  vi.restoreAllMocks();
});

function createHost(fixtures: SceneContractFixtures, world: FakeWorld = createFakeWorld()): SceneContractHost<Entity, Entity> {
  const port = new IWSDKScenePort(asWorld(world), {
    async load(def, parent) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no fixture for ${def.src}`);
      for (let turn = 0; turn < (fixture.turns ?? 0); turn += 1) await Promise.resolve();
      if (fixture.fail === true) throw new Error(`fixture ${def.src} fails`);
      return {
        nodes: fixture.nodes.map((node) => {
          const entity = world.createTransformEntity(box(node.position), fake(parent));
          entity.addComponent(LevelTag, { id: "level" });
          return { id: node.id, entity: asEntity(entity) as Entity };
        }),
      };
    },
    assets: (asset) => {
      if (!fixtures.assets.includes(asset)) throw new Error(`no asset ${asset}`);
      return box([0, 0, 0]);
    },
  });
  const raycaster = new Raycaster();
  const exists = (node: Entity) =>
    !fake(node).destroyed && fake(node).object3D !== undefined && isUnder(fake(node).object3D as Object3D, world.scene);
  const worldPosition = (node: Entity): Vec3 => {
    world.scene.updateMatrixWorld(true);
    const at = (fake(node).object3D as Object3D).getWorldPosition(new Vector3());
    return [at.x, at.y, at.z];
  };
  return {
    port,
    inspect: {
      exists,
      isShown(node) {
        if (!exists(node)) return false;
        for (let at: Object3D | null = fake(node).object3D as Object3D; at !== null; at = at.parent) {
          if (!at.visible) return false;
        }
        return true;
      },
      isHitTestable(node) {
        if (!exists(node)) return false;
        const object = fake(node).object3D as Object3D & { pointerEvents?: unknown };
        if (object.pointerEvents === "none") return false;
        const [x, y, z] = worldPosition(node);
        raycaster.set(new Vector3(x, y + 10, z), new Vector3(0, -1, 0));
        return raycaster.intersectObject(world.scene, true).some((hit) => isUnder(hit.object, object));
      },
      worldPosition,
      liveCount: () => world.created.filter((entity) => !entity.destroyed).length,
    },
  };
}

describe("SceneManager contract on IWSDK", () => {
  for (const contractCase of sceneManagerContractCases()) {
    it(contractCase.name, () => contractCase.run({ create: (fixtures) => createHost(fixtures) }));
  }
});

describe("IWSDKScenePort", () => {
  it("loads with IWSDK's own scene importer by default, and strips LevelTag from what it made", async () => {
    const world = createFakeWorld();
    const node = world.createTransformEntity(new Object3D());
    node.addComponent(LevelTag, { id: "level" });
    const load = vi.spyOn(SceneJSONImporter, "load").mockResolvedValue({
      nodes: new Map([["floor", { nodeId: "floor", entity: node }]]),
    } as never);
    const port = new IWSDKScenePort(asWorld(world));
    const root = await port.build({ id: "a", src: "/a.iwsdk.scene.json" }, true, () => {});
    expect(load).toHaveBeenCalledWith(world, "/a.iwsdk.scene.json", root);
    expect(port.nodeIds(root)).toEqual(["floor"]);
    expect(port.findNode(root, "floor")).toBe(node);
    expect(node.hasComponent(LevelTag)).toBe(false);
    expect(fake(root).parent).toBe(world.sceneEntity);
  });

  it("instantiates a preloaded glTF by default, and names an asset that is not one", async () => {
    const world = createFakeWorld();
    const prefab = new Group();
    vi.spyOn(AssetManager, "getGLTF").mockImplementation((key) => (key === "ball" ? ({ scene: prefab } as never) : null));
    const port = new IWSDKScenePort(asWorld(world), { load: async () => ({ nodes: [] }) });
    const root = await port.build({ id: "a", src: "a" }, true, () => {});
    const pose = { position: [1, 2, 3], orientation: [0, 0, 0, 1] } as const;
    const ball = port.instantiate("ball", pose, root, null);
    expect(fake(ball).object3D).not.toBe(prefab);
    expect(fake(ball).object3D?.position.toArray()).toEqual([1, 2, 3]);
    expect(() => port.instantiate("nope", pose, root, null)).toThrow(/not a preloaded glTF/);
  });

  it("destroys its root when the loader fails", async () => {
    const world = createFakeWorld();
    const port = new IWSDKScenePort(asWorld(world), {
      load: async () => {
        throw new Error("load broke");
      },
    });
    await expect(port.build({ id: "a", src: "a" }, true, () => {})).rejects.toThrow(/load broke/);
    expect(world.created.every((entity) => entity.destroyed)).toBe(true);
  });

  it("takes a detached node's child entities with it, and keeps a repeated id's first node", async () => {
    const world = createFakeWorld();
    let parentEntity: FakeEntity | undefined;
    let childEntity: FakeEntity | undefined;
    let twin: FakeEntity | undefined;
    const port = new IWSDKScenePort(asWorld(world), {
      async load(_def, parent) {
        parentEntity = world.createTransformEntity(new Object3D(), fake(parent));
        childEntity = world.createTransformEntity(new Object3D(), parentEntity);
        twin = world.createTransformEntity(new Object3D(), fake(parent));
        return {
          nodes: [
            { id: "hud", entity: asEntity(parentEntity) },
            { id: "part", entity: asEntity(childEntity) },
            { id: "hud", entity: asEntity(twin) },
          ],
        };
      },
    });
    const root = await port.build({ id: "a", src: "a" }, true, () => {});
    expect(port.findNode(root, "hud")).toBe(parentEntity);
    const hud = port.findNode(root, "hud") as Entity;
    port.detachNode(root, hud);
    expect(port.findNode(root, "hud")).toBeNull();
    expect(fake(hud).object3D?.parent).toBe(world.scene);
    port.destroy(root);
    expect(childEntity?.destroyed).toBe(false);
    expect(twin?.destroyed).toBe(true);
    port.destroyNode(hud);
    expect(childEntity?.destroyed).toBe(true);
    expect(fake(hud).destroyed).toBe(true);
    expect(port.nodeIds(root)).toEqual([]);
    port.detachNode(root, asEntity(world.createTransformEntity(new Object3D(), world.sceneEntity)));
    port.destroyNode(asEntity(world.createTransformEntity(new Object3D(), world.sceneEntity)));
  });

  it("restores an object's own layers and pointerEvents when it is shown again", async () => {
    const world = createFakeWorld();
    const object = new Object3D() as Object3D & { pointerEvents?: unknown };
    object.layers.set(2);
    object.pointerEvents = "auto";
    const port = new IWSDKScenePort(asWorld(world), {
      load: async (_def, parent) => ({ nodes: [{ id: "n", entity: asEntity(world.createTransformEntity(object, fake(parent))) }] }),
    });
    const root = await port.build({ id: "a", src: "a" }, false, () => {});
    expect(object.layers.mask).toBe(0);
    expect(object.pointerEvents).toBe("none");
    port.setVisible(root, true);
    expect(object.layers.mask).toBe(1 << 2);
    expect(object.pointerEvents).toBe("auto");
  });

  it("keeps an instance spawned into a hidden scene hidden until the scene is shown", async () => {
    const world = createFakeWorld();
    const port = new IWSDKScenePort(asWorld(world), {
      load: async () => ({ nodes: [] }),
      assets: () => new Object3D(),
    });
    const root = await port.build({ id: "a", src: "a" }, false, () => {});
    const ball = port.instantiate("ball", { position: [0, 0, 0], orientation: [0, 0, 0, 1] }, root, null);
    const object = fake(ball).object3D as Object3D & { pointerEvents?: unknown };
    expect(object.layers.mask).toBe(0);
    expect(object.pointerEvents).toBe("none");
    port.setVisible(root, true);
    expect(object.layers.mask).toBe(1);
    expect(object.pointerEvents).toBeUndefined();
  });

  it("createIWSDKScenes wires a manager to the port", async () => {
    const world = createFakeWorld();
    const { manager, port } = createIWSDKScenes(asWorld(world), { load: async () => ({ nodes: [] }) });
    expect(port).toBeInstanceOf(IWSDKScenePort);
    manager.register([{ id: "a", src: "a" }]);
    await manager.load("a");
    expect(world.scene.children).toHaveLength(1);
    manager.dispose();
    expect(world.scene.children).toHaveLength(0);
  });
});
