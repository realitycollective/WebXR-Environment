/**
 * The Environment family's native test harness: one bundle a native host
 * runs, built by the WebXR-to-native conversion pipeline (`rc check`, `rc
 * build`) from this repository's own source, and run under Node against the
 * repository's reference fakes when no native host is installed.
 *
 * Modes (`debug.rc.mode` on a device, `__rcShell.mode` under Node):
 *
 *   kits   run every suite this family ships (the environment, audio and
 *          world sensing port suites, the scene manager suite and the host
 *          conformance kit) against the shell's test host, or the fakes under
 *          Node; one JSON line per suite and a `done` line with `pass`. A
 *          suite the test host cannot serve is reported as skipped with its
 *          reason. The default under Node.
 *   play   a timed tour over the live `__rcHost` for a person wearing the
 *          headset, looping until the app closes: a stock preset every 8
 *          seconds with a 3 second eased transition, a positional cue at each
 *          step, depth occlusion and light estimation requested once per loop,
 *          and two small scenes loaded, layered and unloaded around one
 *          persistent node. Every change is a `step` line, and a `status`
 *          line follows once a second. The default on a device.
 *
 * The bundle contains no engine and no browser: three.js appears only in the
 * cook step that turns the tour's meshes into glTF for the host
 * (`scene-assets.ts`), never in this entry.
 */
import {
  DEFAULT_OCCLUSION,
  STOCK_PRESETS,
  createNativeAudio,
  createNativeEnvironment,
  createNativeScenes,
  createNativeWorldSensing,
  type AudioCue,
  type SensingReport,
  type Vec3,
  type WorldPose,
} from "@realitycollective/native-environment";
import { emit, hasShell, readMode, round, virtualClock } from "./src/prelude.js";
import { runEnvironmentKits, shellTestSlices, type EnvironmentTestSlices } from "./src/kits.js";
import { referenceTestSlices } from "./src/fakes.js";
import { TOUR_BEACON, TOUR_SCENES, TOUR_SCENE_A, TOUR_SCENE_B } from "./src/tour-layout.js";

type Mode = "kits" | "play";
const mode = readMode(hasShell() ? "play" : "kits") as Mode;
const g = globalThis as Record<string, unknown>;

emit("harness", { family: "environment", mode, shell: hasShell() });

let done: { pass: boolean } | null = null;
let displayNow = 0;
let lastDisplayMs: number | null = null;

/** The frame entry the shell calls once per frame with the predicted display time in milliseconds. */
function installTick(tick: (displayMs: number, dtMs: number) => void): void {
  g.__rcTick = (displayMs: number): void => {
    const dtMs = lastDisplayMs === null ? 0 : Math.min(100, Math.max(0, displayMs - lastDisplayMs));
    lastDisplayMs = displayMs;
    displayNow = displayMs;
    virtualClock.advance(dtMs);
    tick(displayMs, dtMs);
  };
  g.__rcRenderDone = (): boolean => done !== null;
  g.__rcStatus = (): string => JSON.stringify({ mode, displayMs: round(displayNow, 1), done: done?.pass ?? null });
}

// --- kits ------------------------------------------------------------------------------------
async function runKits(): Promise<void> {
  const shell = shellTestSlices();
  const slices: EnvironmentTestSlices = shell ?? referenceTestSlices();
  emit("kits-host", { source: shell ? "shell test host (__rcShell.testHost)" : "reference fakes", slices: (["environment", "audio", "sensing", "scenes", "input"] as const).filter((name) => slices[name] !== undefined) });
  const result = await runEnvironmentKits(slices);
  done = { pass: result.pass };
  emit("done", {
    pass: result.pass,
    suites: result.suites.length,
    skipped: result.suites.filter((s) => s.skipped).map((s) => `${s.name}: ${s.reason ?? ""}`),
    failures: result.suites.flatMap((s) => s.failures.map((f) => `${s.name}: ${f.name}: ${f.error}`)),
  });
}

// --- play ------------------------------------------------------------------------------------
/** How long each preset holds, and how long the move to it takes, milliseconds. */
const STEP_MS = 8000;
const TRANSITION_MS = 3000;
/** How far from the head a cue sounds, metres. */
const CUE_DISTANCE = 1.5;
const PRESET_NAMES = Object.keys(STOCK_PRESETS);
const DIRECTIONS = ["ahead", "left", "right"] as const;

const TICK_CUE: AudioCue = { id: "tick", src: "kit://tick.wav", bus: "sfx", positional: true };

interface Head {
  position: Vec3;
  quaternion: readonly [number, number, number, number];
}

/** The viewer's head from the live `input` slice, or a standing head facing -Z when the host has none. */
function readHead(): Head {
  const input = (g.__rcHost as { input?: { getHeadPose?(): { position: readonly number[]; quaternion: readonly number[] } | undefined } }).input;
  const pose = input?.getHeadPose?.();
  if (!pose) return { position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] };
  return {
    position: [pose.position[0]!, pose.position[1]!, pose.position[2]!],
    quaternion: [pose.quaternion[0]!, pose.quaternion[1]!, pose.quaternion[2]!, pose.quaternion[3]!],
  };
}

/** The level forward and right of a head: its facing on the floor plane, so a cue never sounds above or below it. */
function levelAxes(q: Head["quaternion"]): { forward: Vec3; right: Vec3 } {
  const [x, y, z, w] = q;
  // Rotate v = (0, 0, -1) by q: v' = v + 2 * cross(u, cross(u, v) + w * v), with u = (x, y, z).
  // cross(u, v) + w * v = (-y, x, -w), which gives the x and z of v' below.
  const tx = -y;
  const ty = x;
  const tz = -w;
  const fx = 2 * (y * tz - z * ty);
  const fz = -1 + 2 * (x * ty - y * tx);
  const length = Math.hypot(fx, fz);
  const forward: Vec3 = length < 1e-6 ? [0, 0, -1] : [fx / length, 0, fz / length];
  // right = forward x up
  return { forward, right: [-forward[2], 0, forward[0]] };
}

function play(): void {
  const host = g.__rcHost as Record<string, unknown>;
  const has = (slice: string): boolean => typeof host[slice] === "object" && host[slice] !== null;
  const at = (): number => round(displayNow, 1);

  const { director: environment } = createNativeEnvironment(undefined, { presets: STOCK_PRESETS, initial: STOCK_PRESETS[PRESET_NAMES[PRESET_NAMES.length - 1]!]! });
  const audioSetup = has("audio") ? createNativeAudio(undefined, { cues: [TICK_CUE] }) : null;
  const sensingSetup = has("sensing") ? createNativeWorldSensing() : null;
  const scenesSetup = has("scenes") ? createNativeScenes() : null;
  const audio = audioSetup?.director ?? null;
  const sensing = sensingSetup?.director ?? null;
  const manager = scenesSetup?.manager ?? null;

  const logReport = (source: string) => (report: SensingReport): void => {
    emit("sensing", { at: at(), source, feature: report.feature, state: report.state, ...(report.detail ? { detail: report.detail } : {}) });
  };
  environment.onSensing(logReport("environment"));
  sensing?.onSensing(logReport("world"));
  manager?.onSceneLoaded((id) => emit("scene-event", { at: at(), event: "loaded", scene: id }));
  manager?.onSceneUnloaded((id) => emit("scene-event", { at: at(), event: "unloaded", scene: id }));
  manager?.onActiveSceneChanged((from, to) => emit("scene-event", { at: at(), event: "active", from, to }));
  manager?.register(TOUR_SCENES.map((scene) => ({ id: scene.id, src: scene.src })));

  // Scene work is asynchronous. It runs one job at a time so a step never overlaps the last.
  let queue: Promise<void> = Promise.resolve();
  const job = (name: string, work: () => Promise<void> | void): void => {
    queue = queue.then(work).catch((error: unknown) => {
      emit("error", { at: at(), name, error: String((error as Error)?.stack ?? error) });
    });
  };

  let beaconMade = false;
  let stepCount = -1;
  let voices = 0;
  let currentPreset = "none";

  const step = (name: string, fields: Record<string, unknown> = {}): void => {
    emit("step", { at: at(), name, loop: Math.floor(stepCount / PRESET_NAMES.length), ...fields });
  };

  function cueStep(): void {
    if (!audio) {
      step("cue-skipped", { reason: "the host has no audio slice" });
      return;
    }
    const direction = DIRECTIONS[voices % DIRECTIONS.length]!;
    voices += 1;
    const head = readHead();
    const { forward, right } = levelAxes(head.quaternion);
    const sign = direction === "left" ? -1 : 1;
    const axis = direction === "ahead" ? forward : right;
    const scale = direction === "ahead" ? CUE_DISTANCE : sign * CUE_DISTANCE;
    const where: Vec3 = [head.position[0] + axis[0] * scale, head.position[1], head.position[2] + axis[2] * scale];
    const voice = audio.play("tick", { at: where });
    step("cue", { direction, at3: where.map((n) => round(n)), distance: CUE_DISTANCE, voice: voice?.id ?? null });
  }

  function requestSensing(): void {
    environment.setOcclusion(DEFAULT_OCCLUSION);
    environment.setLightEstimation(true);
    sensing?.setDetection({ planes: true });
    step("sensing-request", { occlusion: DEFAULT_OCCLUSION.mode, lightEstimation: true, planes: sensing !== null, note: "occlusion applies while passthrough is on" });
  }

  function releaseSensing(): void {
    environment.setOcclusion(null);
    environment.setLightEstimation(null);
    sensing?.setDetection(null);
    step("sensing-release");
  }

  /** The scene switch, one action per preset step: single load, additive load, unload, and one persistent node. */
  function sceneStep(index: number): void {
    if (!manager) {
      if (index === 1) step("scene-skipped", { reason: "the host has no scenes slice" });
      return;
    }
    if (index === 0 && manager.isLoaded(TOUR_SCENE_A.id)) {
      step("scene-unload", { scene: TOUR_SCENE_A.id });
      job("unload a", () => manager.unload(TOUR_SCENE_A.id));
    } else if (index === 1) {
      step("scene-load-single", { scene: TOUR_SCENE_A.id, src: TOUR_SCENE_A.src });
      job("load a", async () => {
        await manager.load(TOUR_SCENE_A.id, { mode: "single" });
        step("scene-loaded", { scene: TOUR_SCENE_A.id, nodes: TOUR_SCENE_A.parts.map((p) => p.name), active: manager.getActiveScene() });
        if (!beaconMade) {
          beaconMade = true;
          manager.instantiate(TOUR_BEACON.name, { position: [...TOUR_BEACON.position], orientation: [0, 0, 0, 1] } as WorldPose, { scene: TOUR_SCENE_A.id, id: TOUR_BEACON.name });
          manager.makePersistent(TOUR_SCENE_A.id, TOUR_BEACON.name);
          step("scene-persist", { node: TOUR_BEACON.name, asset: TOUR_BEACON.name });
        }
      });
    } else if (index === 3) {
      step("scene-load-additive", { scene: TOUR_SCENE_B.id, src: TOUR_SCENE_B.src });
      job("load b", async () => {
        await manager.load(TOUR_SCENE_B.id, { mode: "additive", makeActive: true });
        step("scene-loaded", { scene: TOUR_SCENE_B.id, nodes: TOUR_SCENE_B.parts.map((p) => p.name), active: manager.getActiveScene() });
      });
    } else if (index === 5) {
      step("scene-unload", { scene: TOUR_SCENE_B.id });
      job("unload b", () => manager.unload(TOUR_SCENE_B.id));
    }
  }

  function runStep(): void {
    const index = stepCount % PRESET_NAMES.length;
    currentPreset = PRESET_NAMES[index]!;
    step(`preset:${currentPreset}`, { index, transitionMs: TRANSITION_MS, easing: "easeInOut" });
    environment.transition(currentPreset, { durationMs: TRANSITION_MS, easing: "easeInOut" });
    cueStep();
    if (index === 0) requestSensing();
    if (index === PRESET_NAMES.length - 1) releaseSensing();
    sceneStep(index);
  }

  let elapsedMs = 0;
  let lastSecond = -1;
  installTick((_displayMs, dtMs) => {
    elapsedMs += dtMs;
    environment.update(dtMs);
    audio?.update(dtMs);
    sensing?.update(dtMs);
    const due = Math.floor(elapsedMs / STEP_MS);
    while (stepCount < due) {
      stepCount += 1;
      runStep();
    }
    const second = Math.floor(elapsedMs / 1000);
    if (second !== lastSecond) {
      lastSecond = second;
      emit("status", {
        at: at(),
        elapsedS: second,
        loop: Math.floor(stepCount / PRESET_NAMES.length),
        preset: currentPreset,
        transitioning: environment.transitioning,
        scenesLoaded: manager?.loaded().map((s) => `${s.id}:${s.state}`) ?? null,
        activeScene: manager?.getActiveScene() ?? null,
        voicesPlaying: audio?.activeVoices.length ?? null,
        sensing: {
          occlusion: environment.getSensing("occlusion").state,
          lightEstimation: environment.getSensing("lightEstimation").state,
          planes: sensing?.getSensing("planes").state ?? "no sensing slice",
        },
      });
    }
  });
  emit("play", {
    presets: PRESET_NAMES,
    stepMs: STEP_MS,
    transitionMs: TRANSITION_MS,
    slices: { environment: has("environment"), audio: audio !== null, sensing: sensing !== null, scenes: manager !== null },
  });
}

// --- boot ------------------------------------------------------------------------------------
if (mode === "kits") {
  installTick(() => undefined);
  void runKits().catch((error) => {
    done = { pass: false };
    emit("done", { pass: false, error: String((error as Error)?.stack ?? error) });
  });
} else if (!hasShell()) {
  emit("done", { pass: false, error: `mode "${mode}" needs a native host (__rcHost); under Node use --mode kits` });
  installTick(() => undefined);
  done = { pass: false };
} else {
  play();
}
