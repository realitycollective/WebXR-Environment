/**
 * The Environment family's shared contract suites and host conformance kit,
 * run against a native host's test slices on the device, or against this
 * repository's reference fakes under Node. One JSON line per suite and one
 * `done` line at the end, the shape the conversion pipeline's runner reads.
 *
 * On a device the shell installs `__rcShell.testHost`: a second host object
 * (never the live `__rcHost`, whose frames the suites must not disturb)
 * carrying `environment`, `audio` (when the host has a mixer), `scenes` and
 * `input` slices, a `resetEnvironment()` and `readbacks` with the
 * `NativeEnvironmentTestHost` and `NativeAudioTestHost` members the kit reads
 * back through. It carries no `sensing` slice. Under Node the fakes stand in,
 * so the same bundle proves the bundle.
 *
 * Two suites cannot always run, and a suite that cannot is reported as
 * skipped with its reason, never dropped and never counted as a pass:
 *
 * - the world sensing port suite needs a `sensing` slice;
 * - the audio port suite needs a driver that ends a voice as the host would,
 *   and the shell's audio slice has none.
 */
import {
  audioPortContractCases,
  environmentPortContractCases,
  nativeEnvironmentHostConformanceCases,
  NativeAudioPort,
  NativeEnvironmentPort,
  NativeScenePort,
  NativeWorldSensingPort,
  sceneManagerContractCases,
  worldSensingPortContractCases,
  type AudioPortContractDriver,
  type NativeAudioHost,
  type NativeAudioTestHost,
  type NativeEnvironmentHost,
  type NativeEnvironmentTestHost,
  type NativeScenesHost,
  type NativeSensingHost,
  type SceneContractFixtures,
  type SceneContractHost,
  type WorldPose,
} from "@realitycollective/native-environment";
import { emit, round, settle, shellGlobal } from "./prelude.js";

/** The shell's `scenes` test slice: the port's slice plus the drivers the scene suite reads through. */
export interface TestScenes extends NativeScenesHost {
  /** Define what each `src` builds, for the case about to run. */
  defineFixtures(fixtures: SceneContractFixtures): void;
  /** Remove everything a previous case built. */
  reset?(): void;
  /** Answers about a node, by its key, from the host's own records. */
  readonly inspect: {
    exists(node: string): boolean;
    isShown(node: string): boolean;
    isHitTestable(node: string): boolean;
    worldPosition(node: string): readonly number[];
    liveCount(): number;
  };
}

/** What the shell's test host carries for this family. */
export interface EnvironmentTestSlices {
  environment?: NativeEnvironmentHost;
  audio?: NativeAudioHost;
  sensing?: NativeSensingHost;
  scenes?: TestScenes;
  /** Only the head pose is read, for the listener case. `quaternion` is x, y, z, w. */
  input?: { getHeadPose?(): { readonly position: readonly number[]; readonly quaternion: readonly number[] } };
  /** Return the environment slice to a clean state before a kit case. */
  resetEnvironment?(): void;
  readbacks?: { environment?: NativeEnvironmentTestHost; audio?: NativeAudioTestHost };
  /** Drivers only the reference fakes have: the shell's test host does not. */
  drivers?: { endVoice?(voiceId: number): void };
}

export interface SuiteResult {
  name: string;
  pass: number;
  fail: number;
  total: number;
  skipped?: number;
  reason?: string;
  failures: Array<{ name: string; error: string }>;
}

/** The shell's test host, if the shell installed one. */
export function shellTestSlices(): EnvironmentTestSlices | null {
  const test = shellGlobal().testHost;
  if (typeof test !== "object" || test === null) return null;
  const t = test as EnvironmentTestSlices;
  if (!t.environment && !t.scenes && !t.audio) return null;
  return t;
}

async function runCases<S>(
  name: string,
  cases: readonly { name: string; run(subject: S): void | Promise<void> }[],
  subject: () => S | string,
  after: (subject: S) => void = () => undefined,
): Promise<SuiteResult> {
  const result: SuiteResult = { name, pass: 0, fail: 0, total: 0, failures: [] };
  for (const c of cases) {
    result.total += 1;
    const s = subject();
    if (typeof s === "string") {
      result.fail += 1;
      result.failures.push({ name: c.name, error: s });
      continue;
    }
    try {
      const out = c.run(s);
      if (out && typeof (out as Promise<void>).then === "function") await settle(out as Promise<void>);
      result.pass += 1;
    } catch (error) {
      result.fail += 1;
      result.failures.push({ name: c.name, error: String((error as Error)?.message ?? error) });
    } finally {
      after(s);
    }
  }
  emit("suite", { name, pass: result.pass, fail: result.fail, total: result.total, failures: result.failures });
  return result;
}

/** A suite the host cannot serve: reported, with the reason, as skipped. It is not a pass and not a failure. */
function skipped(name: string, total: number, reason: string): SuiteResult {
  const result: SuiteResult = { name, pass: 0, fail: 0, total, skipped: total, reason, failures: [] };
  emit("suite", { name, pass: 0, fail: 0, total, skipped: total, reason, failures: [] });
  return result;
}

const START_TIMEOUT_MS = 25;

/** Run every suite this family ships against the slices given. */
export async function runEnvironmentKits(slices: EnvironmentTestSlices): Promise<{ suites: SuiteResult[]; pass: boolean }> {
  const suites: SuiteResult[] = [];
  const reset = (): void => slices.resetEnvironment?.();

  // environment port
  const environmentName = "environment port (NativeEnvironmentPort)";
  const environment = slices.environment;
  suites.push(
    await runCases(environmentName, environmentPortContractCases(), () => {
      if (!environment) return "the test host has no environment slice";
      reset();
      return { port: new NativeEnvironmentPort(environment) };
    }),
  );

  // audio port
  const audioName = "audio port (NativeAudioPort)";
  const audio = slices.audio;
  const endVoice = slices.drivers?.endVoice;
  if (!audio) {
    suites.push(await runCases(audioName, audioPortContractCases(), () => "the test host has no audio slice"));
  } else if (!endVoice) {
    suites.push(skipped(audioName, audioPortContractCases().length, "the test host has no driver that ends a voice as the host would; the suite needs one to prove a voice's ended fires exactly once"));
  } else {
    suites.push(
      await runCases(audioName, audioPortContractCases(), () => {
        const driver: AudioPortContractDriver = { end: (voiceId) => endVoice(voiceId) };
        return { port: new NativeAudioPort(audio, { startTimeoutMs: START_TIMEOUT_MS }), driver, startTimeoutMs: START_TIMEOUT_MS };
      }),
    );
  }

  // world sensing port
  const sensingName = "world sensing port (NativeWorldSensingPort)";
  const sensing = slices.sensing;
  if (!sensing) {
    suites.push(skipped(sensingName, worldSensingPortContractCases().length, "the test host has no sensing slice"));
  } else {
    suites.push(await runCases(sensingName, worldSensingPortContractCases(), () => ({ port: new NativeWorldSensingPort(sensing) })));
  }

  // scene manager over the scene port
  const sceneName = "scene manager (SceneManager over NativeScenePort)";
  const scenes = slices.scenes;
  suites.push(
    await runCases(sceneName, sceneManagerContractCases(), () => {
      if (!scenes) return "the test host has no scenes slice";
      return {
        create(fixtures: SceneContractFixtures): SceneContractHost<string, string> {
          scenes.reset?.();
          scenes.defineFixtures(fixtures);
          const inspect = scenes.inspect;
          return {
            port: new NativeScenePort(scenes),
            inspect: {
              exists: (node) => inspect.exists(node),
              isShown: (node) => inspect.isShown(node),
              isHitTestable: (node) => inspect.isHitTestable(node),
              worldPosition: (node) => inspect.worldPosition(node) as [number, number, number],
              liveCount: () => inspect.liveCount(),
            },
          };
        },
      };
    }),
  );

  // host conformance kit
  const kitName = "environment host kit (nativeEnvironmentHostConformanceCases)";
  const getHeadPose = slices.input?.getHeadPose;
  suites.push(
    await runCases(kitName, nativeEnvironmentHostConformanceCases(), () => {
      const environmentTest = slices.readbacks?.environment;
      if (!environment || !environmentTest) return "the test host has no environment slice or no readbacks.environment";
      reset();
      return {
        environment,
        environmentTest,
        audio,
        audioTest: slices.readbacks?.audio,
        cueSrc: "kit://tick.wav",
        skySrc: "kit://sky.hdr",
        ...(getHeadPose
          ? {
              headPose: (): WorldPose => {
                const head = getHeadPose.call(slices.input);
                return { position: [head.position[0]!, head.position[1]!, head.position[2]!], orientation: [head.quaternion[0]!, head.quaternion[1]!, head.quaternion[2]!, head.quaternion[3]!] };
              },
            }
          : {}),
      };
    }),
  );

  const pass = suites.every((s) => s.fail === 0);
  emit("kits", { pass, suites: suites.map((s) => ({ name: s.name, pass: s.pass, fail: s.fail, total: s.total, ...(s.skipped ? { skipped: s.skipped } : {}) })), elapsedMs: round(0) });
  return { suites, pass };
}
