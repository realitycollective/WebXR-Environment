/**
 * An in-memory scene host for the core's own tests: the smallest thing that
 * behaves like a real one. A node is shown when every node above it is
 * active and the chain reaches the world root; a hidden scene is a root with
 * no parent, the way the three.js port detaches one.
 *
 * Every `break*` option makes the port break one promise, which is how
 * `scene-contract-cases.test.ts` proves each case can fail.
 */
import type {
  SceneContractFixtures,
  SceneContractHost,
  SceneDefinition,
  ScenePort,
  Vec3,
  WorldPose,
} from "../src/index.js";

export interface MemoryNode {
  readonly id: string;
  position: Vec3;
  parent: MemoryNode | null;
  active: boolean;
  destroyed: boolean;
  /** The scene's own nodes, on a scene root only. */
  readonly nodes: MemoryNode[];
}

export interface MemoryHostBreaks {
  /** Build and keep hidden scenes attached, so they are shown. */
  readonly showHidden?: boolean;
  /** `destroy` removes the root and leaves its nodes. */
  readonly leakNodes?: boolean;
  /** Instances are spawned outside their scene and `destroyInstance` does nothing. */
  readonly keepInstances?: boolean;
  /** `detachNode` does nothing, so the node goes down with its scene. */
  readonly ignoreDetach?: boolean;
  /** `destroyNode` does nothing. */
  readonly keepDetached?: boolean;
  /** `setNodeActive` does nothing. */
  readonly ignoreActive?: boolean;
  /** `instantiate` ignores the pose. */
  readonly spawnAtOrigin?: boolean;
  /** A failing build leaves a node behind. */
  readonly leakOnFailure?: boolean;
  /** `findNode` answers with a fresh object instead of the node. */
  readonly wrongNode?: boolean;
}

export interface MemoryHost extends SceneContractHost<MemoryNode, MemoryNode> {
  readonly world: MemoryNode;
  readonly port: ScenePort<MemoryNode, MemoryNode> & { disposed: number };
  readonly built: string[];
}

function node(id: string, position: Vec3, parent: MemoryNode | null): MemoryNode {
  return { id, position, parent, active: true, destroyed: false, nodes: [] };
}

async function turns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await Promise.resolve();
}

export function createMemoryHost(fixtures: SceneContractFixtures, breaks: MemoryHostBreaks = {}): MemoryHost {
  const world = node("world", [0, 0, 0], null);
  const live = new Set<MemoryNode>();
  const built: string[] = [];

  const make = (id: string, position: Vec3, parent: MemoryNode | null): MemoryNode => {
    const made = node(id, position, parent);
    live.add(made);
    return made;
  };
  const isUnder = (child: MemoryNode, ancestor: MemoryNode): boolean => {
    for (let at: MemoryNode | null = child; at !== null; at = at.parent) if (at === ancestor) return true;
    return false;
  };
  const destroyTree = (root: MemoryNode): void => {
    for (const candidate of [...live]) {
      if (isUnder(candidate, root)) {
        candidate.destroyed = true;
        live.delete(candidate);
      }
    }
  };

  const port: MemoryHost["port"] = {
    disposed: 0,
    async build(def: SceneDefinition, visible: boolean, onProgress: (progress: number) => void) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no fixture for ${def.src}`);
      onProgress(0);
      await turns(fixture.turns ?? 0);
      if (fixture.fail === true) {
        if (breaks.leakOnFailure) make("leak", [0, 0, 0], world);
        throw new Error(`fixture ${def.src} fails`);
      }
      const root = make(def.id, [0, 0, 0], visible || breaks.showHidden ? world : null);
      for (const entry of fixture.nodes) root.nodes.push(make(entry.id, entry.position, root));
      built.push(def.id);
      onProgress(2);
      return root;
    },
    setVisible(root, visible) {
      root.parent = visible || breaks.showHidden ? world : null;
    },
    destroy(root) {
      if (breaks.leakNodes) {
        root.destroyed = true;
        live.delete(root);
        return;
      }
      destroyTree(root);
    },
    nodeIds(root) {
      return root.nodes.map((entry) => entry.id);
    },
    findNode(root, nodeId) {
      const found = root.nodes.find((entry) => entry.id === nodeId && isUnder(entry, root)) ?? null;
      if (found !== null && breaks.wrongNode) return node(nodeId, found.position, null);
      return found;
    },
    setNodeActive(target, active) {
      if (!breaks.ignoreActive) target.active = active;
    },
    instantiate(asset: string, pose: WorldPose, root, parent) {
      if (!fixtures.assets.includes(asset)) throw new Error(`no asset ${asset}`);
      const under = breaks.keepInstances ? world : (parent ?? root);
      return make(asset, breaks.spawnAtOrigin ? [0, 0, 0] : pose.position, under);
    },
    destroyInstance(instance) {
      if (!breaks.keepInstances) destroyTree(instance);
    },
    detachNode(_root, target) {
      if (!breaks.ignoreDetach) target.parent = world;
    },
    destroyNode(target) {
      if (!breaks.keepDetached) destroyTree(target);
    },
    dispose() {
      this.disposed += 1;
    },
  };

  const isShown = (target: MemoryNode): boolean => {
    if (target.destroyed) return false;
    for (let at: MemoryNode | null = target; at !== null; at = at.parent) {
      if (!at.active) return false;
      if (at === world) return true;
    }
    return false;
  };

  return {
    world,
    port,
    built,
    inspect: {
      exists: (target) => !target.destroyed && live.has(target),
      isShown,
      isHitTestable: isShown,
      worldPosition: (target) => target.position,
      liveCount: () => live.size,
    },
  };
}
