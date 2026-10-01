/**
 * The scene management suite over the real `ThreeScenePort` and a real
 * three.js scene. The inspector answers from three.js itself: a node exists
 * when it is in the graph under the root, is shown when every object above it
 * is visible, and is hit-testable when a stock `Raycaster` fired down at it
 * finds it.
 */
import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Object3D, Raycaster, Scene, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  createThreeScenes,
  sceneManagerContractCases,
  ThreeScenePort,
  type SceneContractFixtures,
  type SceneContractHost,
  type Vec3,
} from "@realitycollective/threejs-environment";

const GEOMETRY = new BoxGeometry(0.2, 0.2, 0.2);
const MATERIAL = new MeshBasicMaterial();

function box(name: string, position: Vec3): Mesh {
  const mesh = new Mesh(GEOMETRY, MATERIAL);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

function isUnder(object: Object3D, ancestor: Object3D): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) if (at === ancestor) return true;
  return false;
}

/** A three.js root, a port whose loader builds the fixtures as meshes, and an inspector over the graph. */
function createThreeSceneHost(fixtures: SceneContractFixtures, root: Object3D = new Scene()): SceneContractHost<Group, Object3D> {
  const port = new ThreeScenePort(root, {
    async load(def) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no fixture for ${def.src}`);
      await turns(fixture.turns ?? 0);
      if (fixture.fail === true) throw new Error(`fixture ${def.src} fails`);
      const content = new Group();
      for (const node of fixture.nodes) content.add(box(node.id, node.position));
      return content;
    },
    assets: (asset) => {
      if (!fixtures.assets.includes(asset)) throw new Error(`no asset ${asset}`);
      return box("", [0, 0, 0]);
    },
  });
  const raycaster = new Raycaster();
  const exists = (node: Object3D) => node !== root && isUnder(node, root);
  const isShown = (node: Object3D) => {
    if (!exists(node)) return false;
    for (let at: Object3D | null = node; at !== null; at = at.parent) if (!at.visible) return false;
    return true;
  };
  const worldPosition = (node: Object3D): Vec3 => {
    root.updateMatrixWorld(true);
    const at = node.getWorldPosition(new Vector3());
    return [at.x, at.y, at.z];
  };
  return {
    port,
    inspect: {
      exists,
      isShown,
      isHitTestable(node) {
        if (!exists(node)) return false;
        const [x, y, z] = worldPosition(node);
        raycaster.set(new Vector3(x, y + 10, z), new Vector3(0, -1, 0));
        return raycaster.intersectObject(root, true).some((hit) => isUnder(hit.object, node));
      },
      worldPosition,
      liveCount() {
        let count = -1;
        root.traverse(() => (count += 1));
        return count;
      },
    },
  };
}

describe("SceneManager contract on three.js", () => {
  for (const contractCase of sceneManagerContractCases()) {
    it(contractCase.name, () => contractCase.run({ create: (fixtures) => createThreeSceneHost(fixtures) }));
  }
});

describe("ThreeScenePort", () => {
  it("loads glTF by default, reporting progress only when the size is known", async () => {
    const content = new Group();
    content.add(new Object3D());
    const spy = vi.spyOn(GLTFLoader.prototype, "loadAsync").mockImplementation(async (_url, onProgress) => {
      onProgress?.({ loaded: 5, total: 10 } as ProgressEvent);
      onProgress?.({ loaded: 5, total: 0 } as ProgressEvent);
      return { scene: content } as never;
    });
    const root = new Scene();
    const port = new ThreeScenePort(root);
    const progress: number[] = [];
    const group = await port.build({ id: "a", src: "a.glb" }, true, (value) => progress.push(value));
    expect(spy).toHaveBeenCalledWith("a.glb", expect.any(Function));
    expect(progress).toEqual([0.5]);
    expect(group.children[0]).toBe(content);
    expect(port.nodeIds(group)).toEqual([]);
    spy.mockRestore();
  });

  it("takes a node id from userData.nodeId before the name, and keeps the first of a repeat", async () => {
    const first = new Object3D();
    first.userData.nodeId = "tee";
    first.name = "ignored";
    const second = new Object3D();
    second.name = "tee";
    const content = new Group();
    content.add(first, second);
    const port = new ThreeScenePort(new Scene(), { load: async () => content });
    const group = await port.build({ id: "a", src: "a" }, true, () => {});
    expect(port.nodeIds(group)).toEqual(["tee", "tee"]);
    expect(port.findNode(group, "tee")).toBe(first);
    port.destroy(group);
    expect(port.nodeIds(group)).toEqual([]);
    expect(port.findNode(group, "tee")).toBeNull();
  });

  it("refuses to instantiate without an assets factory", async () => {
    const port = new ThreeScenePort(new Scene(), { load: async () => new Group() });
    const group = await port.build({ id: "a", src: "a" }, true, () => {});
    expect(() => port.instantiate("ball", { position: [0, 0, 0], orientation: [0, 0, 0, 1] }, group, null)).toThrow(
      /assets factory/,
    );
  });

  it("places an instance at a world pose under a moved and turned parent", async () => {
    const root = new Scene();
    const parent = new Object3D();
    parent.name = "arm";
    parent.position.set(1, 2, 3);
    parent.rotation.y = Math.PI / 2;
    const content = new Group();
    content.add(parent);
    const port = new ThreeScenePort(root, { load: async () => content, assets: () => new Object3D() });
    const group = await port.build({ id: "a", src: "a" }, true, () => {});
    const instance = port.instantiate(
      "x",
      { position: [4, 5, 6], orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      group,
      port.findNode(group, "arm"),
    );
    root.updateMatrixWorld(true);
    const at = instance.getWorldPosition(new Vector3());
    expect(at.x).toBeCloseTo(4);
    expect(at.y).toBeCloseTo(5);
    expect(at.z).toBeCloseTo(6);
    expect(instance.parent).toBe(parent);
  });

  it("restores an object's own layers and pointerEvents when it is shown again", async () => {
    const node = new Object3D() as Object3D & { pointerEvents?: unknown };
    node.name = "n";
    node.layers.set(3);
    node.pointerEvents = "auto";
    const content = new Group();
    content.add(node);
    const port = new ThreeScenePort(new Scene(), { load: async () => content });
    const group = await port.build({ id: "a", src: "a" }, false, () => {});
    expect(node.layers.mask).toBe(0);
    expect(node.pointerEvents).toBe("none");
    port.setNodeActive(node, false);
    port.setVisible(group, true);
    expect(node.layers.mask).toBe(0);
    port.setNodeActive(node, true);
    expect(node.layers.mask).toBe(1 << 3);
    expect(node.pointerEvents).toBe("auto");
  });

  it("keeps a detached node's world pose, and drops it from its scene", async () => {
    const root = new Scene();
    const node = new Object3D();
    node.name = "hud";
    node.position.set(1, 1, 1);
    const content = new Group();
    content.position.set(2, 0, 0);
    content.add(node);
    const port = new ThreeScenePort(root, { load: async () => content });
    const group = await port.build({ id: "a", src: "a" }, false, () => {});
    port.detachNode(group, node);
    expect(node.parent).toBe(root);
    expect(node.position.x).toBeCloseTo(3);
    expect(node.visible).toBe(true);
    expect(node.layers.mask).toBe(1);
    expect(port.findNode(group, "hud")).toBeNull();
    port.destroy(group);
    port.detachNode(group, new Object3D());
    port.destroyNode(node);
    expect(node.parent).toBeNull();
  });

  it("keeps an instance spawned into a hidden scene hidden until the scene is shown", async () => {
    const port = new ThreeScenePort(new Scene(), { load: async () => new Group(), assets: () => new Object3D() });
    const group = await port.build({ id: "a", src: "a" }, false, () => {});
    const ball = port.instantiate("ball", { position: [0, 0, 0], orientation: [0, 0, 0, 1] }, group, null);
    expect(ball.layers.mask).toBe(0);
    port.setVisible(group, true);
    expect(ball.layers.mask).toBe(1);
  });

  it("createThreeScenes wires a manager to the port", async () => {
    const root = new Scene();
    const { manager, port } = createThreeScenes(root, { load: async () => new Group() });
    expect(port).toBeInstanceOf(ThreeScenePort);
    manager.register([{ id: "a", src: "a" }]);
    await manager.load("a");
    expect(root.children).toHaveLength(1);
    manager.dispose();
    expect(root.children).toHaveLength(0);
  });
});
