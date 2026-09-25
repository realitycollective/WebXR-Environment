/**
 * The scene management suite over what `createXRBlocksScenes` hands back: the
 * three.js scene port, under the kind of `Scene` XR Blocks renders. The
 * inspector answers from three.js itself, as it does in `threejs-environment`.
 */
import { describe, expect, it } from "vitest";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Raycaster, Scene, Vector3 } from "three";
import {
  createXRBlocksScenes,
  sceneManagerContractCases,
  ThreeScenePort,
  type SceneContractFixtures,
  type SceneContractHost,
  type Vec3,
} from "@realitycollective/xrblocks-environment";

const GEOMETRY = new BoxGeometry(0.2, 0.2, 0.2);
const MATERIAL = new MeshBasicMaterial();

function box(name: string, position: Vec3): Mesh {
  const mesh = new Mesh(GEOMETRY, MATERIAL);
  mesh.name = name;
  mesh.position.set(position[0], position[1], position[2]);
  return mesh;
}

function isUnder(object: Object3D, ancestor: Object3D): boolean {
  for (let at: Object3D | null = object; at !== null; at = at.parent) if (at === ancestor) return true;
  return false;
}

function createHost(fixtures: SceneContractFixtures): SceneContractHost<Group, Object3D> {
  const root = new Scene();
  const { port } = createXRBlocksScenes(root, {
    async load(def) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no fixture for ${def.src}`);
      for (let turn = 0; turn < (fixture.turns ?? 0); turn += 1) await Promise.resolve();
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
  const worldPosition = (node: Object3D): Vec3 => {
    root.updateMatrixWorld(true);
    const at = node.getWorldPosition(new Vector3());
    return [at.x, at.y, at.z];
  };
  return {
    port,
    inspect: {
      exists,
      isShown(node) {
        if (!exists(node)) return false;
        for (let at: Object3D | null = node; at !== null; at = at.parent) if (!at.visible) return false;
        return true;
      },
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

describe("SceneManager contract on XR Blocks", () => {
  for (const contractCase of sceneManagerContractCases()) {
    it(contractCase.name, () => contractCase.run({ create: createHost }));
  }

  it("createXRBlocksScenes hands back the three.js scene port", () => {
    expect(createXRBlocksScenes(new Scene()).port).toBeInstanceOf(ThreeScenePort);
  });
});
