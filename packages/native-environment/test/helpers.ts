/**
 * In-memory fakes for the three slices this package reads.
 *
 * Each fake is the whole slice, so a test can hand one straight to a port's
 * constructor - the same "injected, for tests" path a real app uses to avoid
 * `globalThis.__rcHost` in its own unit tests. Every member defaults to
 * present; pass `false` for one in the options to build a host that is
 * missing it, which is how the "the port omits what the host lacks" tests
 * drive both sides.
 */
import { vi } from "vitest";
import type {
  EstimatedLighting,
  SensingReport,
  WorldAnchor,
  WorldHit,
  WorldMesh,
  WorldPlane,
} from "@realitycollective/webxr-environment";
import type {
  NativeAudioHost,
  NativeAudioVoiceRequest,
  NativeEnvironmentHost,
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
