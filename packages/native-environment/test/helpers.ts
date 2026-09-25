/**
 * In-memory fakes for the four slices this package reads.
 *
 * Each fake is the whole slice, so a test can hand one straight to a port's
 * constructor - the same "injected, for tests" path a real app uses to avoid
 * `globalThis.__rcHost` in its own unit tests. Every member defaults to
 * present; pass `false` for one in the options to build a host that is
 * missing it, which is how the "the port omits what the host lacks" tests
 * drive both sides.
 */
import { vi } from "vitest";
import {
  SCENE_CONTRACT_FIXTURES,
  type EstimatedLighting,
  type SceneContractFixtures,
  type SensingReport,
  type Vec3,
  type WorldAnchor,
  type WorldHit,
  type WorldMesh,
  type WorldPlane,
  type WorldPose,
} from "@realitycollective/webxr-environment";
import type {
  NativeAudioHost,
  NativeAudioVoiceRequest,
  NativeEnvironmentHost,
  NativeScenesHost,
  NativeSensingHost,
} from "../src/native-types.js";

export interface FakeEnvironmentHostOptions {
  readonly applyOcclusion?: boolean;
  readonly applyLightEstimation?: boolean;
  readonly onSensingReport?: boolean;
  readonly onLightEstimate?: boolean;
}

export interface FakeEnvironmentHost extends NativeEnvironmentHost {
  /** Fire as though the host itself reported this - only works when built with reporting on. */
  emitSensingReport(report: SensingReport): void;
  /** Fire as though the host itself measured this - only works when built with reporting on. */
  emitLightEstimate(estimate: EstimatedLighting | null): void;
}

export function createFakeEnvironmentHost(options: FakeEnvironmentHostOptions = {}): FakeEnvironmentHost {
  const sensingListeners = new Set<(report: SensingReport) => void>();
  const estimateListeners = new Set<(estimate: EstimatedLighting | null) => void>();

  const host: FakeEnvironmentHost = {
    applySky: vi.fn(),
    applyFog: vi.fn(),
    applyAmbient: vi.fn(),
    applyKeyLight: vi.fn(),
    applyIbl: vi.fn(),
    emitSensingReport(report) {
      for (const listener of sensingListeners) listener(report);
    },
    emitLightEstimate(estimate) {
      for (const listener of estimateListeners) listener(estimate);
    },
  };

  if (options.applyOcclusion ?? true) host.applyOcclusion = vi.fn();
  if (options.applyLightEstimation ?? true) host.applyLightEstimation = vi.fn();
  if (options.onSensingReport ?? true) {
    host.onSensingReport = vi.fn((callback) => {
      sensingListeners.add(callback);
      return () => {
        sensingListeners.delete(callback);
      };
    });
  }
  if (options.onLightEstimate ?? true) {
    host.onLightEstimate = vi.fn((callback) => {
      estimateListeners.add(callback);
      return () => {
        estimateListeners.delete(callback);
      };
    });
  }
  return host;
}

export interface FakeAudioHostOptions {
  readonly load?: boolean;
  readonly setGain?: boolean;
}

export interface FakeAudioHost extends NativeAudioHost {
  readonly requests: NativeAudioVoiceRequest[];
  readonly stopped: number[];
  emitVoiceEnded(voiceId: number): void;
}

export function createFakeAudioHost(options: FakeAudioHostOptions = {}): FakeAudioHost {
  const endedListeners = new Set<(voiceId: number) => void>();
  const requests: NativeAudioVoiceRequest[] = [];
  const stopped: number[] = [];

  const host: FakeAudioHost = {
    requests,
    stopped,
    start: vi.fn((request: NativeAudioVoiceRequest) => {
      requests.push(request);
    }),
    stop: vi.fn((voiceId: number) => {
      stopped.push(voiceId);
    }),
    onVoiceEnded: vi.fn((callback) => {
      endedListeners.add(callback);
      return () => {
        endedListeners.delete(callback);
      };
    }),
    emitVoiceEnded(voiceId) {
      for (const listener of endedListeners) listener(voiceId);
    },
  };

  if (options.load ?? true) host.load = vi.fn();
  if (options.setGain ?? true) host.setGain = vi.fn();
  return host;
}

export interface FakeSensingHostOptions {
  readonly setDetection?: boolean;
  readonly startHitTest?: boolean;
  readonly stopHitTest?: boolean;
  readonly createAnchor?: boolean;
  readonly removeAnchor?: boolean;
  readonly onPlanes?: boolean;
  readonly onMeshes?: boolean;
  readonly onAnchors?: boolean;
  readonly onHits?: boolean;
  readonly onSensingReport?: boolean;
}

export interface FakeSensingHost extends NativeSensingHost {
  emitPlanes(planes: readonly WorldPlane[]): void;
  emitMeshes(meshes: readonly WorldMesh[]): void;
  emitAnchors(anchors: readonly WorldAnchor[]): void;
  emitHits(sourceId: string, hits: readonly WorldHit[]): void;
  emitSensingReport(report: SensingReport): void;
}

export function createFakeSensingHost(options: FakeSensingHostOptions = {}): FakeSensingHost {
  const planeListeners = new Set<(planes: readonly WorldPlane[]) => void>();
  const meshListeners = new Set<(meshes: readonly WorldMesh[]) => void>();
  const anchorListeners = new Set<(anchors: readonly WorldAnchor[]) => void>();
  const hitListeners = new Set<(sourceId: string, hits: readonly WorldHit[]) => void>();
  const sensingListeners = new Set<(report: SensingReport) => void>();

  const host: FakeSensingHost = {
    emitPlanes(planes) {
      for (const listener of planeListeners) listener(planes);
    },
    emitMeshes(meshes) {
      for (const listener of meshListeners) listener(meshes);
    },
    emitAnchors(anchors) {
      for (const listener of anchorListeners) listener(anchors);
    },
    emitHits(sourceId, hits) {
      for (const listener of hitListeners) listener(sourceId, hits);
    },
    emitSensingReport(report) {
      for (const listener of sensingListeners) listener(report);
    },
  };

  if (options.setDetection ?? true) host.setDetection = vi.fn();
  if (options.startHitTest ?? true) host.startHitTest = vi.fn();
  if (options.stopHitTest ?? true) host.stopHitTest = vi.fn();
  if (options.createAnchor ?? true) host.createAnchor = vi.fn(async () => "anchor-1");
  if (options.removeAnchor ?? true) host.removeAnchor = vi.fn();
  if (options.onPlanes ?? true) {
    host.onPlanes = vi.fn((callback) => {
      planeListeners.add(callback);
      return () => {
        planeListeners.delete(callback);
      };
    });
  }
  if (options.onMeshes ?? true) {
    host.onMeshes = vi.fn((callback) => {
      meshListeners.add(callback);
      return () => {
        meshListeners.delete(callback);
      };
    });
  }
  if (options.onAnchors ?? true) {
    host.onAnchors = vi.fn((callback) => {
      anchorListeners.add(callback);
      return () => {
        anchorListeners.delete(callback);
      };
    });
  }
  if (options.onHits ?? true) {
    host.onHits = vi.fn((callback) => {
      hitListeners.add(callback);
      return () => {
        hitListeners.delete(callback);
      };
    });
  }
  if (options.onSensingReport ?? true) {
    host.onSensingReport = vi.fn((callback) => {
      sensingListeners.add(callback);
      return () => {
        sensingListeners.delete(callback);
      };
    });
  }
  return host;
}

export interface FakeScenesHostOptions {
  /** What each `src` builds. Default: the shared contract fixtures. */
  readonly fixtures?: SceneContractFixtures;
  readonly onBuildProgress?: boolean;
}

/** One node the fake native app holds, by its key. */
export interface FakeNativeNode {
  readonly key: string;
  readonly id: string;
  /** The owning scene's key, or `null` once `detachNode` moved it out. */
  scene: string | null;
  /** The parent node's key, or `null` for a node directly in its scene. */
  readonly parent: string | null;
  readonly position: Vec3;
  active: boolean;
  destroyed: boolean;
}

export interface FakeScenesHost extends NativeScenesHost {
  readonly nodes: Map<string, FakeNativeNode>;
  readonly scenes: Map<string, { visible: boolean; destroyed: boolean }>;
  /** What the native app renders and hit-tests right now. */
  isShown(key: string): boolean;
  /** Everything the app has built and not yet removed: scenes and nodes. */
  liveCount(): number;
  emitBuildProgress(sceneId: string, progress: number): void;
}

/**
 * A native app's `scenes` slice, in memory. Builds each `src` from the
 * fixtures, keys every scene and node, and keeps world positions as given.
 * A node is shown while it and every node above it are active and its scene
 * is visible; a detached node belongs to no scene and is shown while active.
 */
export function createFakeScenesHost(options: FakeScenesHostOptions = {}): FakeScenesHost {
  const fixtures = options.fixtures ?? SCENE_CONTRACT_FIXTURES;
  const progressListeners = new Set<(sceneId: string, progress: number) => void>();
  const nodes = new Map<string, FakeNativeNode>();
  const scenes = new Map<string, { visible: boolean; destroyed: boolean }>();
  let next = 1;
  const key = (label: string) => `${label}:${String(next++)}`;
  const destroyTree = (target: string) => {
    for (const entry of nodes.values()) {
      if (entry.key === target || entry.parent === target) {
        if (!entry.destroyed && entry.key !== target) destroyTree(entry.key);
        entry.destroyed = true;
      }
    }
  };

  const host: FakeScenesHost = {
    nodes,
    scenes,
    async build(def, visible) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no scene at ${def.src}`);
      for (let turn = 0; turn < (fixture.turns ?? 0); turn += 1) await Promise.resolve();
      if (fixture.fail === true) throw new Error(`${def.src} failed to build`);
      const scene = key(`scene/${def.id}`);
      scenes.set(scene, { visible, destroyed: false });
      const built = fixture.nodes.map((entry) => {
        const node: FakeNativeNode = {
          key: key(`node/${entry.id}`),
          id: entry.id,
          scene,
          parent: null,
          position: [...entry.position],
          active: true,
          destroyed: false,
        };
        nodes.set(node.key, node);
        return { id: entry.id, key: node.key };
      });
      return { scene, nodes: built };
    },
    setVisible: vi.fn((scene: string, visible: boolean) => {
      const entry = scenes.get(scene);
      if (entry !== undefined) entry.visible = visible;
    }),
    destroy: vi.fn((scene: string) => {
      const entry = scenes.get(scene);
      if (entry !== undefined) entry.destroyed = true;
      for (const node of nodes.values()) if (node.scene === scene) node.destroyed = true;
    }),
    setNodeActive: vi.fn((node: string, active: boolean) => {
      const entry = nodes.get(node);
      if (entry !== undefined) entry.active = active;
    }),
    instantiate: vi.fn((asset: string, pose: WorldPose, scene: string, parent: string | null) => {
      if (!fixtures.assets.includes(asset)) throw new Error(`no asset ${asset}`);
      const node: FakeNativeNode = {
        key: key(`instance/${asset}`),
        id: asset,
        scene: parent === null ? scene : (nodes.get(parent)?.scene ?? scene),
        parent,
        position: [...pose.position],
        active: true,
        destroyed: false,
      };
      nodes.set(node.key, node);
      return node.key;
    }),
    destroyInstance: vi.fn((instance: string) => destroyTree(instance)),
    detachNode: vi.fn((_scene: string, node: string) => {
      const detach = (target: string) => {
        const entry = nodes.get(target);
        if (entry === undefined) return;
        entry.scene = null;
        for (const child of nodes.values()) if (child.parent === target) detach(child.key);
      };
      detach(node);
    }),
    destroyNode: vi.fn((node: string) => destroyTree(node)),
    isShown(target) {
      let entry = nodes.get(target);
      if (entry === undefined || entry.destroyed) return false;
      for (;;) {
        if (!entry.active) return false;
        if (entry.parent === null) break;
        const parent = nodes.get(entry.parent);
        if (parent === undefined) break;
        entry = parent;
      }
      if (entry.scene === null) return true;
      const scene = scenes.get(entry.scene);
      return scene !== undefined && scene.visible && !scene.destroyed;
    },
    liveCount() {
      let count = 0;
      for (const scene of scenes.values()) if (!scene.destroyed) count += 1;
      for (const node of nodes.values()) if (!node.destroyed) count += 1;
      return count;
    },
    emitBuildProgress(sceneId, progress) {
      for (const listener of progressListeners) listener(sceneId, progress);
    },
  };

  if (options.onBuildProgress ?? true) {
    host.onBuildProgress = vi.fn((callback) => {
      progressListeners.add(callback);
      return () => {
        progressListeners.delete(callback);
      };
    });
  }
  return host;
}
