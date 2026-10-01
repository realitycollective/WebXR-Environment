/**
 * The reference fakes as a test host, for a harness run with no native host
 * (Node in CI, or a shell that installs no test host). Every slice here is
 * written to behave as a CORRECT host would, and imports nothing from the
 * package's tests (they pull in a test runner, which a native bundle must not
 * contain): they draw what they are handed, report back what a real host
 * reports, attenuate by the core's distance models and keep the listener at
 * the head. The host kit's own tests hold the same behaviour and show the kit
 * fails a host without it.
 */
import { SCENE_CONTRACT_FIXTURES, distanceGain, type EstimatedLighting, type OcclusionSpec, type ResolvedLightEstimation, type SceneContractFixtures, type SensingReport, type Vec3, type WorldAnchor, type WorldHit, type WorldMesh, type WorldPlane, type WorldPose } from "@realitycollective/webxr-environment";
import type { NativeAudioHost, NativeAudioTestHost, NativeAudioVoiceRequest, NativeEnvironmentHost, NativeEnvironmentTestHost, NativeScenesHost, NativeSensingHost } from "@realitycollective/native-environment";
import type { EnvironmentTestSlices, TestScenes } from "./kits.js";

/** Where the reference host keeps the viewer's head, and so its audio listener. */
const HEAD: WorldPose = { position: [0.5, 1.6, -0.25], orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };

type Slot = "sky" | "fog" | "ambient" | "key" | "ibl";

/** An environment host that applies every slot, reports what a real one reports, and can be reset between cases. */
function referenceEnvironment(): { environment: NativeEnvironmentHost; environmentTest: NativeEnvironmentTestHost; reset(): void } {
  const applied = new Map<Slot, unknown>();
  let occlusion: OcclusionSpec | null | undefined;
  let drawnSkyKind: "solid" | "gradient" | "texture" | null | undefined;
  let drawnFogKind: "linear" | "exponential" | null | undefined;
  let castsShadow: boolean | null | undefined;
  let iblActive: boolean | undefined;
  let lightEstimation: ResolvedLightEstimation | null | undefined;
  const estimateListeners = new Set<(estimate: EstimatedLighting | null) => void>();
  const reportListeners = new Set<(report: SensingReport) => void>();
  const report = (r: SensingReport): void => {
    for (const listener of [...reportListeners]) listener(r);
  };

  const store = (slot: Slot, value: unknown): void => {
    applied.set(slot, value === null ? null : JSON.parse(JSON.stringify(value)));
  };
  const environment: NativeEnvironmentHost = {
    applySky: (sky) => {
      store("sky", sky);
      drawnSkyKind = sky === null ? null : sky.kind;
    },
    applyFog: (fog) => {
      store("fog", fog);
      drawnFogKind = fog === null ? null : fog.kind;
    },
    applyAmbient: (ambient) => store("ambient", ambient),
    applyKeyLight: (key) => {
      store("key", key);
      castsShadow = key === null ? null : (key.castShadow ?? false);
    },
    applyIbl: (ibl) => {
      store("ibl", ibl);
      iblActive = ibl !== null;
    },
    applyOcclusion: (spec) => {
      occlusion = spec;
      report(spec === null ? { feature: "occlusion", state: "unavailable" } : { feature: "occlusion", state: "active" });
    },
    applyLightEstimation: (spec) => {
      lightEstimation = spec;
      if (spec === null) {
        report({ feature: "lightEstimation", state: "unavailable" });
        return;
      }
      report({ feature: "lightEstimation", state: "active" });
      for (const listener of [...estimateListeners]) listener({ ambient: { colour: [0.4, 0.4, 0.4], intensity: 0.8 } });
    },
    onLightEstimate: (callback) => {
      estimateListeners.add(callback);
      return () => {
        estimateListeners.delete(callback);
      };
    },
    onSensingReport: (callback) => {
      reportListeners.add(callback);
      return () => {
        reportListeners.delete(callback);
      };
    },
  };
  const environmentTest: NativeEnvironmentTestHost = {
    applied: (slot) => applied.get(slot),
    appliedOcclusion: () => occlusion,
    drawnSkyKind: () => drawnSkyKind,
    drawnFogKind: () => drawnFogKind,
    drawnKeyLightCastsShadow: () => castsShadow,
    drawnIblActive: () => iblActive,
    appliedLightEstimation: () => lightEstimation,
  };
  const reset = (): void => {
    applied.clear();
    occlusion = undefined;
    drawnSkyKind = undefined;
    drawnFogKind = undefined;
    castsShadow = undefined;
    iblActive = undefined;
    lightEstimation = undefined;
  };
  return { environment, environmentTest, reset };
}

/** An audio host that sounds what it is handed until stopped or ended, attenuates by the core's models and listens at the head. */
function referenceAudio(): { audio: NativeAudioHost; audioTest: NativeAudioTestHost; end(voiceId: number): void } {
  const voices = new Map<number, NativeAudioVoiceRequest>();
  const endedListeners = new Set<(voiceId: number) => void>();
  const audio: NativeAudioHost = {
    start: (request) => {
      voices.set(request.voiceId, request);
    },
    stop: (voiceId) => {
      voices.delete(voiceId);
    },
    onVoiceEnded: (callback) => {
      endedListeners.add(callback);
      return () => {
        endedListeners.delete(callback);
      };
    },
  };
  const audioTest: NativeAudioTestHost = {
    voices: () => [...voices].map(([voiceId, request]) => ({ voiceId, cueId: request.cue.id })),
    voiceDistanceGain: (voiceId) => {
      const request = voices.get(voiceId);
      if (!request || request.at === null) return 1;
      const d = Math.hypot(request.at[0] - HEAD.position[0], request.at[1] - HEAD.position[1], request.at[2] - HEAD.position[2]);
      return distanceGain(d, request.spatial);
    },
    listenerPose: () => HEAD,
  };
  return {
    audio,
    audioTest,
    end(voiceId) {
      voices.delete(voiceId);
      for (const listener of [...endedListeners]) listener(voiceId);
    },
  };
}

interface AppNode {
  readonly key: string;
  scene: string | null;
  readonly parent: string | null;
  readonly position: Vec3;
  active: boolean;
  destroyed: boolean;
}

/** The `scenes` slice as a shell's test host carries it: the fixtures are defined per case, and an inspector answers from the app's own records. */
function referenceScenes(): TestScenes {
  let fixtures: SceneContractFixtures = SCENE_CONTRACT_FIXTURES;
  let nodes = new Map<string, AppNode>();
  let scenes = new Map<string, { visible: boolean; destroyed: boolean }>();
  let progress = new Set<(sceneId: string, progress: number) => void>();
  let next = 1;
  const key = (label: string): string => `${label}:${String(next++)}`;
  const clear = (): void => {
    nodes = new Map();
    scenes = new Map();
    progress = new Set();
  };
  const destroyTree = (target: string): void => {
    for (const entry of nodes.values()) {
      if (entry.key === target || entry.parent === target) {
        if (!entry.destroyed && entry.key !== target) destroyTree(entry.key);
        entry.destroyed = true;
      }
    }
  };
  const isShown = (target: string): boolean => {
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
  };
  return {
    async build(def, visible) {
      const fixture = fixtures.scenes[def.src];
      if (fixture === undefined) throw new Error(`no scene at ${def.src}`);
      for (let turn = 0; turn < (fixture.turns ?? 0); turn += 1) await Promise.resolve();
      if (fixture.fail === true) throw new Error(`${def.src} failed to build`);
      const scene = key(`scene/${def.id}`);
      scenes.set(scene, { visible, destroyed: false });
      const built = fixture.nodes.map((entry) => {
        const node: AppNode = { key: key(`node/${entry.id}`), scene, parent: null, position: [...entry.position], active: true, destroyed: false };
        nodes.set(node.key, node);
        return { id: entry.id, key: node.key };
      });
      return { scene, nodes: built };
    },
    setVisible(scene, visible) {
      const entry = scenes.get(scene);
      if (entry !== undefined) entry.visible = visible;
    },
    destroy(scene) {
      const entry = scenes.get(scene);
      if (entry !== undefined) entry.destroyed = true;
      for (const node of nodes.values()) if (node.scene === scene) node.destroyed = true;
    },
    setNodeActive(node, active) {
      const entry = nodes.get(node);
      if (entry !== undefined) entry.active = active;
    },
    instantiate(asset, pose, scene, parent) {
      if (!fixtures.assets.includes(asset)) throw new Error(`no asset ${asset}`);
      const node: AppNode = {
        key: key(`instance/${asset}`),
        scene: parent === null ? scene : (nodes.get(parent)?.scene ?? scene),
        parent,
        position: [...pose.position],
        active: true,
        destroyed: false,
      };
      nodes.set(node.key, node);
      return node.key;
    },
    destroyInstance: (instance) => destroyTree(instance),
    detachNode(_scene, node) {
      const detach = (target: string): void => {
        const entry = nodes.get(target);
        if (entry === undefined) return;
        entry.scene = null;
        for (const child of nodes.values()) if (child.parent === target) detach(child.key);
      };
      detach(node);
    },
    destroyNode: (node) => destroyTree(node),
    onBuildProgress(callback) {
      progress.add(callback);
      return () => {
        progress.delete(callback);
      };
    },
    defineFixtures(defined: SceneContractFixtures) {
      clear();
      fixtures = defined;
    },
    reset() {
      clear();
      fixtures = SCENE_CONTRACT_FIXTURES;
    },
    inspect: {
      exists: (node) => nodes.get(node)?.destroyed === false,
      isShown,
      isHitTestable: isShown,
      worldPosition: (node) => nodes.get(node)?.position ?? [Number.NaN, Number.NaN, Number.NaN],
      liveCount() {
        let count = 0;
        for (const scene of scenes.values()) if (!scene.destroyed) count += 1;
        for (const node of nodes.values()) if (!node.destroyed) count += 1;
        return count;
      },
    },
  };
}

/** A sensing host that answers a request as a real one does: detection reports planes active, a hit test reports pending. */
function referenceSensing(): NativeSensingHost {
  const listeners = <A extends unknown[]>(): { add(cb: (...args: A) => void): () => void; fire(...args: A): void } => {
    const set = new Set<(...args: A) => void>();
    return {
      add(cb) {
        set.add(cb);
        return () => {
          set.delete(cb);
        };
      },
      fire(...args) {
        for (const cb of [...set]) cb(...args);
      },
    };
  };
  const planes = listeners<[readonly WorldPlane[]]>();
  const meshes = listeners<[readonly WorldMesh[]]>();
  const anchors = listeners<[readonly WorldAnchor[]]>();
  const hits = listeners<[string, readonly WorldHit[]]>();
  const reports = listeners<[SensingReport]>();
  let anchorCount = 0;
  return {
    setDetection: (detection) => {
      if (detection?.planes) reports.fire({ feature: "planes", state: "active" });
    },
    startHitTest: () => reports.fire({ feature: "hitTest", state: "pending" }),
    stopHitTest: () => undefined,
    createAnchor: async () => `anchor-${String(++anchorCount)}`,
    removeAnchor: () => undefined,
    onPlanes: planes.add,
    onMeshes: meshes.add,
    onAnchors: anchors.add,
    onHits: hits.add,
    onSensingReport: reports.add,
  };
}

/** The reference fakes as a whole test host. The shell's own `NativeScenesHost` type is what the slices are handed as. */
export function referenceTestSlices(): EnvironmentTestSlices {
  const env = referenceEnvironment();
  const audio = referenceAudio();
  const scenes: NativeScenesHost & TestScenes = referenceScenes();
  return {
    environment: env.environment,
    audio: audio.audio,
    sensing: referenceSensing(),
    scenes,
    input: { getHeadPose: () => ({ position: [...HEAD.position], quaternion: [...HEAD.orientation] }) },
    resetEnvironment: () => env.reset(),
    readbacks: { environment: env.environmentTest, audio: audio.audioTest },
    drivers: { endVoice: (voiceId) => audio.end(voiceId) },
  };
}
