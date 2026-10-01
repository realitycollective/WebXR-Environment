/**
 * `ScenePort` for a native host: the `scenes` slice of `globalThis.__rcHost`.
 *
 * A translator and nothing more. The manager has decided the order, what
 * survives and which scene is active; the native app builds, shows and
 * destroys. Handles are the app's own string keys, so the node `getNode`
 * returns is the key the app also uses as that node's target id in the
 * `interactions` slice.
 *
 * Plain values only cross: the pose is copied into fresh tuples, and build
 * progress arrives through the slice's optional `onBuildProgress` listener,
 * routed to the build that asked for it by scene id.
 */
import type { SceneDefinition, ScenePort, WorldPose } from "@realitycollective/webxr-environment";
import type { NativeScenesHost } from "./native-types.js";
import { getScenesHost } from "./native-types.js";

interface SceneRecord {
  readonly ids: string[];
  readonly nodes: Map<string, string>;
}

export class NativeScenePort implements ScenePort<string, string> {
  readonly #host: NativeScenesHost;
  readonly #scenes = new Map<string, SceneRecord>();
  readonly #progress = new Map<string, (progress: number) => void>();
  readonly #unsubscribe: (() => void) | undefined;

  constructor(host?: NativeScenesHost) {
    this.#host = getScenesHost(host);
    this.#unsubscribe = this.#host.onBuildProgress?.((sceneId, progress) => {
      this.#progress.get(sceneId)?.(progress);
    });
  }

  async build(def: SceneDefinition, visible: boolean, onProgress: (progress: number) => void): Promise<string> {
    this.#progress.set(def.id, onProgress);
    try {
      const built = await this.#host.build(def, visible);
      const record: SceneRecord = { ids: [], nodes: new Map() };
      for (const { id, key } of built.nodes) {
        record.ids.push(id);
        if (!record.nodes.has(id)) record.nodes.set(id, key);
      }
      this.#scenes.set(built.scene, record);
      return built.scene;
    } finally {
      this.#progress.delete(def.id);
    }
  }

  setVisible(scene: string, visible: boolean): void {
    this.#host.setVisible(scene, visible);
  }

  destroy(scene: string): void {
    this.#scenes.delete(scene);
    this.#host.destroy(scene);
  }

  nodeIds(scene: string): readonly string[] {
    return this.#scenes.get(scene)?.ids ?? [];
  }

  findNode(scene: string, nodeId: string): string | null {
    return this.#scenes.get(scene)?.nodes.get(nodeId) ?? null;
  }

  setNodeActive(node: string, active: boolean): void {
    this.#host.setNodeActive(node, active);
  }

  instantiate(asset: string, pose: WorldPose, scene: string, parent: string | null): string {
    const copy: WorldPose = { position: [...pose.position], orientation: [...pose.orientation] };
    return this.#host.instantiate(asset, copy, scene, parent);
  }

  destroyInstance(instance: string): void {
    this.#host.destroyInstance(instance);
  }

  detachNode(scene: string, node: string): void {
    const record = this.#scenes.get(scene);
    if (record !== undefined) {
      for (const [id, key] of record.nodes) if (key === node) record.nodes.delete(id);
    }
    this.#host.detachNode(scene, node);
  }

  destroyNode(node: string): void {
    this.#host.destroyNode(node);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#progress.clear();
  }
}
