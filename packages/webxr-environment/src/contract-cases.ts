/**
 * The shared `EnvironmentPort` / `AudioPort` / `WorldSensingPort` conformance
 * suites, shipped as data rather than as tests.
 *
 * Every platform in this family (`threejs-`, `iwsdk-`, `xrblocks-`,
 * `native-environment`) promises the same things: an environment port applies
 * every slot's spec variants without throwing and reports what it can and
 * cannot sense through {@link EnvironmentPort.observe}; an audio port retires
 * a voice's `ended` exactly once and never again after it is stopped; a
 * world-sensing port answers a request it accepts and never rejects a promise
 * it hands back. Running one suite from every adapter is what keeps those
 * promises from drifting apart, and gives a new adapter a starting test for
 * free - see `webxr-uiextensions`'s `contract-cases.ts` for the pattern this
 * follows.
 *
 * The suites are runner-free on purpose. Every adapter repository already has
 * its own test runner, so the checks ship as plain objects that throw a plain
 * `Error` on failure and the adapter iterates them:
 *
 * ```ts
 * for (const contractCase of environmentPortContractCases()) {
 *   it(contractCase.name, () => contractCase.run({ port: makePort() }));
 * }
 * ```
 *
 * `makePort()` (or the audio/world-sensing equivalent) runs per case, so each
 * case gets a port of its own - a case that leaves a voice sounding or a
 * subscription open must not leak into the next one.
 */
import type { AmbientLightSpec, FogSpec, IblSpec, KeyLightSpec, SkySpec } from "./environment.js";
import type { AudioCue, AudioVoiceRequest } from "./audio.js";
import type { OcclusionSpec } from "./occlusion.js";
import type { ResolvedLightEstimation } from "./light-estimation.js";
import type { EnvironmentPortHost, SensingReport, SensingState } from "./sensing.js";
import { SENSING_FEATURES } from "./sensing.js";
import type { HitTestRequest, WorldAnchor, WorldMesh, WorldPlane } from "./world-sensing.js";
import type { WorldSensingPort, WorldSensingPortHost } from "./world-sensing-director.js";
import type { AudioPort, EnvironmentPort } from "./ports.js";

/** Every value {@link SensingReport.state} may legally hold. */
const SENSING_STATES: readonly SensingState[] = ["unsupported", "unavailable", "pending", "active"];

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A handful of microtask turns, for a port that answers through a promise chain. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
}

/** Runs one `applyX(value)` call, naming it in the error when it throws. */
function tryApply(label: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new Error(`${label} must not throw: ${String(error)}`);
  }
}

/** Calls the unsubscribe `observe()` returned, naming it in the error when it throws. */
function callUnsubscribe(stop: () => void): void {
  try {
    stop();
  } catch (error) {
    throw new Error(`the unsubscribe returned by observe() threw: ${String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// EnvironmentPort
// ---------------------------------------------------------------------------

/** What an environment port contract case is handed. */
export interface EnvironmentPortContractSubject {
  /** The port under test. Fresh per case: cases apply slots and never clean up. */
  readonly port: EnvironmentPort;
}

/** One check an {@link EnvironmentPort} implementation must pass. */
export interface EnvironmentPortContractCase {
  name: string;
  run(subject: EnvironmentPortContractSubject): void | Promise<void>;
}

const SKY_VARIANTS: readonly (SkySpec | null)[] = [
  { kind: "solid", colour: [0.2, 0.4, 0.8] },
  { kind: "gradient", top: [0.1, 0.2, 0.3], bottom: [0.4, 0.5, 0.6] },
  { kind: "texture", src: "contract://sky.hdr" },
  null,
];

const FOG_VARIANTS: readonly (FogSpec | null)[] = [
  { kind: "linear", colour: [0.5, 0.5, 0.5], near: 1, far: 10 },
  { kind: "exponential", colour: [0.5, 0.5, 0.5], density: 0.01 },
  null,
];

const AMBIENT_VARIANTS: readonly (AmbientLightSpec | null)[] = [
  { colour: [1, 1, 1], intensity: 0.5 },
  null,
];

const KEY_VARIANTS: readonly (KeyLightSpec | null)[] = [
  { colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0] },
  null,
];

const IBL_VARIANTS: readonly (IblSpec | null)[] = [
  { kind: "gradient", top: [0.6, 0.6, 0.6], bottom: [0.2, 0.2, 0.2] },
  { kind: "texture", src: "contract://ibl.hdr" },
  { kind: "room" },
  { kind: "estimated" },
  null,
];

const OCCLUSION_SAMPLE: OcclusionSpec = { mode: "soft", scope: "all" };
const LIGHT_ESTIMATION_SAMPLE: ResolvedLightEstimation = {
  ambient: true,
  key: true,
  ibl: true,
  shadows: false,
};

interface RecordingEnvironmentHost extends EnvironmentPortHost {
  readonly reports: SensingReport[];
}

function recordingEnvironmentHost(): RecordingEnvironmentHost {
  const reports: SensingReport[] = [];
  return {
    reports,
    report: (report) => reports.push(report),
    estimate: () => {},
  };
}

/**
 * The shared `EnvironmentPort` conformance suite. See the file comment for how
 * an adapter runs it.
 */
export function environmentPortContractCases(): readonly EnvironmentPortContractCase[] {
  return ENVIRONMENT_CASES;
}

const ENVIRONMENT_CASES: readonly EnvironmentPortContractCase[] = [
  {
    name: "applies every sky, fog, ambient, key and ibl variant, including null, without throwing",
    run(subject) {
      const { port } = subject;
      for (const sky of SKY_VARIANTS) tryApply(`applySky(${JSON.stringify(sky)})`, () => port.applySky(sky));
      for (const fog of FOG_VARIANTS) tryApply(`applyFog(${JSON.stringify(fog)})`, () => port.applyFog(fog));
      for (const ambient of AMBIENT_VARIANTS) {
        tryApply(`applyAmbient(${JSON.stringify(ambient)})`, () => port.applyAmbient(ambient));
      }
      for (const key of KEY_VARIANTS) tryApply(`applyKeyLight(${JSON.stringify(key)})`, () => port.applyKeyLight(key));
      for (const ibl of IBL_VARIANTS) tryApply(`applyIbl(${JSON.stringify(ibl)})`, () => port.applyIbl(ibl));
    },
  },
  {
    name: "observe returns undefined or a function that can be called",
    run(subject) {
      const stop = subject.port.observe?.(recordingEnvironmentHost());
      if (stop === undefined) return;
      assert(typeof stop === "function", `observe() must return undefined or a function, got ${typeof stop}`);
      callUnsubscribe(stop);
    },
  },
  {
    name: 'a port with applyOcclusion answers a request with a report for feature "occlusion"',
    run(subject) {
      const { port } = subject;
      if (port.applyOcclusion === undefined) return;
      const host = recordingEnvironmentHost();
      port.observe?.(host);
      port.applyOcclusion(OCCLUSION_SAMPLE);
      assert(
        host.reports.some((report) => report.feature === "occlusion"),
        'applyOcclusion() must produce at least one report for feature "occlusion"',
      );
    },
  },
  {
    name: 'a port with applyLightEstimation answers a request with a report for feature "lightEstimation"',
    run(subject) {
      const { port } = subject;
      if (port.applyLightEstimation === undefined) return;
      const host = recordingEnvironmentHost();
      port.observe?.(host);
      port.applyLightEstimation(LIGHT_ESTIMATION_SAMPLE);
      assert(
        host.reports.some((report) => report.feature === "lightEstimation"),
        'applyLightEstimation() must produce at least one report for feature "lightEstimation"',
      );
    },
  },
  {
    name: "every report uses a known feature and a known sensing state",
    run(subject) {
      const { port } = subject;
      const host = recordingEnvironmentHost();
      port.observe?.(host);
      port.applyOcclusion?.(OCCLUSION_SAMPLE);
      port.applyLightEstimation?.(LIGHT_ESTIMATION_SAMPLE);
      for (const report of host.reports) {
        assert(
          (SENSING_FEATURES as readonly string[]).includes(report.feature),
          `a report used an unknown feature "${String(report.feature)}"`,
        );
        assert(
          SENSING_STATES.includes(report.state),
          `a report for "${report.feature}" used an unknown state "${String(report.state)}"`,
        );
      }
    },
  },
  {
    name: "dispose can be called twice",
    run(subject) {
      const { port } = subject;
      if (port.dispose === undefined) return;
      port.dispose();
      try {
        port.dispose();
      } catch (error) {
        throw new Error(`a second dispose() must be a no-op, it threw: ${String(error)}`);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// AudioPort
// ---------------------------------------------------------------------------

/** Makes the host finish a voice as though playback stopped of its own accord. */
export interface AudioPortContractDriver {
  end(voiceId: number): void | Promise<void>;
}

/** What an audio port contract case is handed. */
export interface AudioPortContractSubject {
  /** The port under test. Fresh per case: cases start voices and never clean up. */
  readonly port: AudioPort;
  readonly driver: AudioPortContractDriver;
}

/** One check an {@link AudioPort} implementation must pass. */
export interface AudioPortContractCase {
  name: string;
  run(subject: AudioPortContractSubject): void | Promise<void>;
}

function contractCue(overrides: Partial<AudioCue> = {}): AudioCue {
  return { id: "contract-cue", src: "contract://cue.mp3", ...overrides } as AudioCue;
}

function contractRequest(
  overrides: Partial<AudioVoiceRequest> & { readonly voiceId: number; readonly ended: () => void },
): AudioVoiceRequest {
  return {
    cue: contractCue(),
    gain: 1,
    loop: false,
    at: null,
    spatial: null,
    facing: null,
    ...overrides,
  } as AudioVoiceRequest;
}

/**
 * The shared `AudioPort` conformance suite. See the file comment for how an
 * adapter runs it.
 */
export function audioPortContractCases(): readonly AudioPortContractCase[] {
  return AUDIO_CASES;
}

const AUDIO_CASES: readonly AudioPortContractCase[] = [
  {
    name: "a one-shot's ended runs exactly once, immediately or when driven to end",
    async run(subject) {
      let calls = 0;
      subject.port.start(contractRequest({ voiceId: 101, ended: () => (calls += 1) }));
      if (calls === 0) await subject.driver.end(101);
      assert(calls === 1, `a one-shot voice must call ended exactly once, it was called ${String(calls)} time(s)`);
    },
  },
  {
    name: "a looping voice can be stopped without throwing",
    run(subject) {
      let calls = 0;
      subject.port.start(contractRequest({ voiceId: 102, loop: true, ended: () => (calls += 1) }));
      try {
        subject.port.stop(102);
      } catch (error) {
        throw new Error(`stop() on a looping voice must not throw, it threw: ${String(error)}`);
      }
      assert(
        calls === 0,
        "stop() must not call ended itself; ended is for when the host finishes a voice on its own accord",
      );
    },
  },
  {
    name: "after stop, driving an end does not call ended",
    async run(subject) {
      let calls = 0;
      subject.port.start(contractRequest({ voiceId: 103, loop: true, ended: () => (calls += 1) }));
      subject.port.stop(103);
      await subject.driver.end(103);
      assert(
        calls === 0,
        `driving the end of a voice already stopped must not call ended, it was called ${String(calls)} time(s)`,
      );
    },
  },
  {
    name: "setGain on a sounding voice does not throw, when it implements setGain",
    run(subject) {
      if (subject.port.setGain === undefined) return;
      subject.port.start(contractRequest({ voiceId: 104, ended: () => {} }));
      try {
        subject.port.setGain(104, 0.5);
      } catch (error) {
        throw new Error(`setGain() on a sounding voice must not throw, it threw: ${String(error)}`);
      } finally {
        subject.port.stop(104);
      }
    },
  },
  {
    name: "load returns void or a promise, when it implements load",
    async run(subject) {
      if (subject.port.load === undefined) return;
      const result = subject.port.load(contractCue({ id: "contract-load-cue" }));
      if (result === undefined) return;
      assert(
        typeof (result as Promise<unknown>).then === "function",
        `load() must return void or a promise, got ${typeof result}`,
      );
      await result;
    },
  },
  {
    name: "dispose can be called twice, when it implements dispose",
    run(subject) {
      if (subject.port.dispose === undefined) return;
      subject.port.dispose();
      try {
        subject.port.dispose();
      } catch (error) {
        throw new Error(`a second dispose() must be a no-op, it threw: ${String(error)}`);
      }
    },
  },
];

// ---------------------------------------------------------------------------
// WorldSensingPort
// ---------------------------------------------------------------------------

/** What a world-sensing port contract case is handed. */
export interface WorldSensingPortContractSubject {
  /** The port under test. Fresh per case: cases start requests and never clean up. */
  readonly port: WorldSensingPort;
}

/** One check a {@link WorldSensingPort} implementation must pass. */
export interface WorldSensingPortContractCase {
  name: string;
  run(subject: WorldSensingPortContractSubject): void | Promise<void>;
}

interface RecordingWorldSensingHost extends WorldSensingPortHost {
  readonly reports: SensingReport[];
  readonly planeSets: (readonly WorldPlane[])[];
  readonly meshSets: (readonly WorldMesh[])[];
  readonly anchorSets: (readonly WorldAnchor[])[];
  hitsCalls: number;
}

function recordingWorldSensingHost(): RecordingWorldSensingHost {
  const reports: SensingReport[] = [];
  const planeSets: (readonly WorldPlane[])[] = [];
  const meshSets: (readonly WorldMesh[])[] = [];
  const anchorSets: (readonly WorldAnchor[])[] = [];
  return {
    reports,
    planeSets,
    meshSets,
    anchorSets,
    hitsCalls: 0,
    planes(planes) {
      planeSets.push(planes);
    },
    meshes(meshes) {
      meshSets.push(meshes);
    },
    anchors(anchors) {
      anchorSets.push(anchors);
    },
    hits(_sourceId, _hits) {
      this.hitsCalls += 1;
    },
    report(report) {
      reports.push(report);
    },
  };
}

const HIT_TEST_SAMPLE: HitTestRequest = { id: "contract-hit-test", space: "viewer" };

/**
 * The shared `WorldSensingPort` conformance suite. See the file comment for
 * how an adapter runs it.
 */
export function worldSensingPortContractCases(): readonly WorldSensingPortContractCase[] {
  return WORLD_SENSING_CASES;
}

const WORLD_SENSING_CASES: readonly WorldSensingPortContractCase[] = [
  {
    name: "observe returns undefined or a function that can be called",
    run(subject) {
      const stop = subject.port.observe(recordingWorldSensingHost());
      if (stop === undefined) return;
      assert(typeof stop === "function", `observe() must return undefined or a function, got ${typeof stop}`);
      callUnsubscribe(stop);
    },
  },
  {
    name: 'setDetection with planes on answers with a report for feature "planes", when it implements setDetection',
    run(subject) {
      const { port } = subject;
      if (port.setDetection === undefined) return;
      const host = recordingWorldSensingHost();
      port.observe(host);
      port.setDetection({ planes: true, meshes: false, anchors: false });
      assert(
        host.reports.some((report) => report.feature === "planes"),
        'setDetection({ planes: true, ... }) must produce at least one report for feature "planes"',
      );
    },
  },
  {
    name: 'startHitTest answers with a report for feature "hitTest" or a call to hits(), when it implements startHitTest',
    async run(subject) {
      const { port } = subject;
      if (port.startHitTest === undefined) return;
      const host = recordingWorldSensingHost();
      port.observe(host);
      port.startHitTest(HIT_TEST_SAMPLE);
      await settle();
      assert(
        host.reports.some((report) => report.feature === "hitTest") || host.hitsCalls > 0,
        'startHitTest() must answer with a report for feature "hitTest" or a call to hits()',
      );
      port.stopHitTest?.(HIT_TEST_SAMPLE.id);
    },
  },
  {
    name: "createAnchor resolves to a string or null and never rejects, when it implements createAnchor",
    async run(subject) {
      const { port } = subject;
      if (port.createAnchor === undefined) return;
      let result: string | null;
      try {
        result = await port.createAnchor({ position: [0, 0, 0], orientation: [0, 0, 0, 1] });
      } catch (error) {
        throw new Error(`createAnchor() must never reject, it rejected with: ${String(error)}`);
      }
      assert(
        result === null || typeof result === "string",
        `createAnchor() must resolve to a string or null, got ${typeof result}`,
      );
      if (result !== null) port.removeAnchor?.(result);
    },
  },
  {
    name: "stopHitTest and removeAnchor on unknown ids do not throw",
    run(subject) {
      const { port } = subject;
      try {
        port.stopHitTest?.("no-such-hit-test");
      } catch (error) {
        throw new Error(`stopHitTest() on an unknown id must not throw, it threw: ${String(error)}`);
      }
      try {
        port.removeAnchor?.("no-such-anchor");
      } catch (error) {
        throw new Error(`removeAnchor() on an unknown id must not throw, it threw: ${String(error)}`);
      }
    },
  },
  {
    name: "every report uses a known feature and a known sensing state",
    async run(subject) {
      const { port } = subject;
      const host = recordingWorldSensingHost();
      port.observe(host);
      port.setDetection?.({ planes: true, meshes: true, anchors: true });
      port.startHitTest?.(HIT_TEST_SAMPLE);
      await settle();
      port.stopHitTest?.(HIT_TEST_SAMPLE.id);
      for (const report of host.reports) {
        assert(
          (SENSING_FEATURES as readonly string[]).includes(report.feature),
          `a report used an unknown feature "${String(report.feature)}"`,
        );
        assert(
          SENSING_STATES.includes(report.state),
          `a report for "${report.feature}" used an unknown state "${String(report.state)}"`,
        );
      }
    },
  },
  {
    name: "dispose can be called twice, when it implements dispose",
    run(subject) {
      const { port } = subject;
      if (port.dispose === undefined) return;
      port.dispose();
      try {
        port.dispose();
      } catch (error) {
        throw new Error(`a second dispose() must be a no-op, it threw: ${String(error)}`);
      }
    },
  },
];
