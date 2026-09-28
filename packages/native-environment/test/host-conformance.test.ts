/**
 * The Environment host conformance kit against reference hosts that apply
 * what they are handed, and the negative checks that show it fails a host
 * with the gaps the audit found.
 */
import { describe, expect, it } from "vitest";
import { distanceGain, type WorldPose } from "@realitycollective/webxr-environment";
import type {
  EstimatedLighting,
  OcclusionSpec,
  ResolvedLightEstimation,
  SensingReport,
} from "@realitycollective/webxr-environment";
import { nativeEnvironmentHostConformanceCases } from "../src/index.js";
import type {
  NativeAudioHost,
  NativeAudioTestHost,
  NativeAudioVoiceRequest,
  NativeEnvironmentHost,
  NativeEnvironmentTestHost,
} from "../src/native-types.js";

type Slot = "sky" | "fog" | "ambient" | "key" | "ibl";

interface ReferenceEnvironmentOptions {
  readonly occlusion?: boolean;
  readonly dropNull?: boolean;
  /** "flattened" draws every sky kind as a solid colour, regardless of what it was asked for. */
  readonly skyKind?: "ok" | "flattened";
  /** "flattened" draws every fog kind as linear. */
  readonly fogKind?: "ok" | "flattened";
  /** "stuck-on" always casts a shadow, "never" never does, regardless of `castShadow`. */
  readonly keyShadow?: "ok" | "stuck-on" | "never";
  /** "never-reflects" leaves materials flat regardless of the ibl spec, "always-reflects" never turns it off. */
  readonly ibl?: "ok" | "never-reflects" | "always-reflects";
  /**
   * "silent" has both light-estimation methods but never reports or measures
   * anything - a defect. "wrong-request" hands `applyLightEstimation` a
   * request but the readback echoes something else - a second, earlier kind
   * of defect. "unavailable" reports the feature unavailable instead of ever
   * measuring, a legitimate outcome on a host with no light sensor. "absent"
   * has neither method at all, also legitimate.
   */
  readonly lightEstimation?: "ok" | "silent" | "wrong-request" | "unavailable" | "absent";
}

function referenceEnvironment(options: ReferenceEnvironmentOptions = {}) {
  const applied = new Map<Slot, unknown>();
  let occlusion: OcclusionSpec | null | undefined;
  let drawnSkyKind: "solid" | "gradient" | "texture" | null | undefined;
  let drawnFogKind: "linear" | "exponential" | null | undefined;
  let drawnKeyLightCastsShadow: boolean | null | undefined;
  let drawnIblActive: boolean | undefined;
  let appliedLightEstimation: ResolvedLightEstimation | null | undefined;
  let lightEstimateListener: ((estimate: EstimatedLighting | null) => void) | undefined;
  let sensingReportListener: ((report: SensingReport) => void) | undefined;

  const set = (slot: Slot) => (value: unknown) => {
    if (options.dropNull && value === null) return; // a host that ignores "none"
    applied.set(slot, value === null ? null : JSON.parse(JSON.stringify(value)));
  };
  const environment: NativeEnvironmentHost = {
    applySky: (sky) => {
      set("sky")(sky);
      drawnSkyKind = sky === null ? null : (options.skyKind ?? "ok") === "flattened" ? "solid" : sky.kind;
    },
    applyFog: (fog) => {
      set("fog")(fog);
      drawnFogKind = fog === null ? null : (options.fogKind ?? "ok") === "flattened" ? "linear" : fog.kind;
    },
    applyAmbient: set("ambient"),
    applyKeyLight: (key) => {
      set("key")(key);
      if (key === null) {
        drawnKeyLightCastsShadow = null;
        return;
      }
      const mode = options.keyShadow ?? "ok";
      drawnKeyLightCastsShadow = mode === "stuck-on" ? true : mode === "never" ? false : (key.castShadow ?? false);
    },
    applyIbl: (ibl) => {
      set("ibl")(ibl);
      const mode = options.ibl ?? "ok";
      drawnIblActive = mode === "always-reflects" ? true : mode === "never-reflects" ? false : ibl !== null;
    },
  };
  if (options.occlusion ?? true) environment.applyOcclusion = (spec) => (occlusion = spec);
  if ((options.lightEstimation ?? "ok") !== "absent") {
    environment.applyLightEstimation = (spec) => {
      appliedLightEstimation = options.lightEstimation === "wrong-request" ? null : spec;
      if (options.lightEstimation === "silent" || spec === null) return; // asked, and does nothing about it
      if (options.lightEstimation === "unavailable") {
        sensingReportListener?.({ feature: "lightEstimation", state: "unavailable" });
        return;
      }
      sensingReportListener?.({ feature: "lightEstimation", state: "active" });
      lightEstimateListener?.({ ambient: { colour: [0.4, 0.4, 0.4], intensity: 0.8 } });
    };
    environment.onLightEstimate = (callback) => {
      lightEstimateListener = callback;
      return () => {
        lightEstimateListener = undefined;
      };
    };
    environment.onSensingReport = (callback) => {
      sensingReportListener = callback;
      return () => {
        sensingReportListener = undefined;
      };
    };
  }
  const environmentTest: NativeEnvironmentTestHost = {
    applied: (slot) => applied.get(slot),
    appliedOcclusion: () => occlusion,
    drawnSkyKind: () => drawnSkyKind,
    drawnFogKind: () => drawnFogKind,
    drawnKeyLightCastsShadow: () => drawnKeyLightCastsShadow,
    drawnIblActive: () => drawnIblActive,
    appliedLightEstimation: () => appliedLightEstimation,
  };
  return { environment, environmentTest };
}

/** The head the reference host keeps its listener at. */
const HEAD: WorldPose = { position: [0.5, 1.6, -0.25], orientation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] };

function referenceAudio(options: { ignoreStop?: boolean; listenerOffset?: number; ignoreAttenuation?: boolean } = {}) {
  const voices = new Map<number, { cueId: string; request: NativeAudioVoiceRequest }>();
  const audio: NativeAudioHost = {
    start: (request: NativeAudioVoiceRequest) => voices.set(request.voiceId, { cueId: request.cue.id, request }),
    stop: (voiceId) => {
      if (!options.ignoreStop) voices.delete(voiceId);
    },
    onVoiceEnded: () => () => {},
  };
  const listener: WorldPose = { position: [HEAD.position[0] + (options.listenerOffset ?? 0), HEAD.position[1], HEAD.position[2]], orientation: HEAD.orientation };
  const audioTest: NativeAudioTestHost = {
    voices: () => [...voices].map(([voiceId, voice]) => ({ voiceId, cueId: voice.cueId })),
    // A correct host attenuates exactly by the core's distance models from its listener.
    voiceDistanceGain: (voiceId) => {
      const voice = voices.get(voiceId);
      if (!voice || voice.request.at === null || options.ignoreAttenuation) return 1;
      const at = voice.request.at;
      const d = Math.hypot(at[0] - listener.position[0], at[1] - listener.position[1], at[2] - listener.position[2]);
      return distanceGain(d, voice.request.spatial);
    },
    listenerPose: () => listener,
  };
  return { audio, audioTest };
}

function reference() {
  return { ...referenceEnvironment(), ...referenceAudio(), cueSrc: "kit://click", headPose: () => HEAD };
}

describe("native Environment host conformance kit, against reference hosts", () => {
  const cases = nativeEnvironmentHostConformanceCases();
  const find = (part: string) => cases.find((c) => c.name.includes(part))!;

  it("names every case after its family and row", () => {
    for (const hostCase of cases) expect(hostCase.name).toMatch(/^(environment|audio)\//);
  });

  for (const hostCase of cases) {
    it(hostCase.name, () => hostCase.run(reference()));
  }

  it("fails a host that keeps drawing the sky when handed null", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ dropNull: true }) };
    await expect(find("passthrough suppresses").run(setup)).rejects.toThrow(/null on the host/);
  });

  it("fails a host with no applyOcclusion, the gap the audit found", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ occlusion: false }) };
    await expect(find("occlusion").run(setup)).rejects.toThrow(/no applyOcclusion/);
  });

  it("fails a host that attenuates by its own rule, or cannot be read", async () => {
    const attenuation = find("attenuates by the core defaults");
    await expect(attenuation.run({ ...reference(), ...referenceAudio({ ignoreAttenuation: true }) })).rejects.toThrow(/must be at/);
    const blind = reference();
    await expect(attenuation.run({ ...blind, audioTest: { voices: blind.audioTest.voices } })).rejects.toThrow(/no voiceDistanceGain or listenerPose/);
    const quietNear = reference();
    quietNear.audioTest.voiceDistanceGain = () => 0.5;
    await expect(attenuation.run(quietNear)).rejects.toThrow(/must be at full volume/);
  });

  it("fails a host whose listener is not at the head, or that gives the kit no head", async () => {
    const listener = find("listener is at the viewer");
    await expect(listener.run({ ...reference(), ...referenceAudio({ listenerOffset: 0.5 }) })).rejects.toThrow(/from the head/);
    const turned = reference();
    turned.audioTest.listenerPose = () => ({ position: HEAD.position, orientation: [0, 0, 0, 1] });
    await expect(listener.run(turned)).rejects.toThrow(/does not face/);
    const { headPose: _unused, ...noHead } = reference();
    void _unused;
    await expect(listener.run(noHead)).rejects.toThrow(/no headPose/);
    const noListener = reference();
    await expect(listener.run({ ...noListener, audioTest: { voices: noListener.audioTest.voices } })).rejects.toThrow(/no listenerPose/);
  });

  it("fails a host with no audio slice, the gap the audit found", async () => {
    const setup = { ...reference(), audio: undefined, audioTest: undefined };
    await expect(find("overlap").run(setup)).rejects.toThrow(/no audio slice/);
  });

  it("fails a host that keeps sounding a stopped voice", async () => {
    const setup = { ...reference(), ...referenceAudio({ ignoreStop: true }) };
    await expect(find("stop silences").run(setup)).rejects.toThrow(/still sounds/);
  });

  it("fails a restart host that does not stop the sounding voice", async () => {
    const setup = { ...reference(), ...referenceAudio({ ignoreStop: true }) };
    await expect(find("restart").run(setup)).rejects.toThrow(/expected 1/);
  });

  it("fails a host that paints every sky kind flat, even though it stores the spec correctly", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ skyKind: "flattened" }) };
    await expect(find("every sky kind").run(setup)).rejects.toThrow(/is drawn as "solid"/);
  });

  it("fails a host that draws every fog kind as linear", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ fogKind: "flattened" }) };
    await expect(find("every fog kind").run(setup)).rejects.toThrow(/is drawn as "linear"/);
  });

  it("fails a host whose key light never actually casts a shadow", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ keyShadow: "never" }) };
    await expect(find("castShadow").run(setup)).rejects.toThrow(/castShadow: true is drawn as false/);
  });

  it("fails a host whose key light shadow never turns off", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ keyShadow: "stuck-on" }) };
    await expect(find("castShadow").run(setup)).rejects.toThrow(/castShadow: false is drawn as true/);
  });

  it("fails a host whose materials never reflect an ibl spec", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ ibl: "never-reflects" }) };
    await expect(find("ibl spec").run(setup)).rejects.toThrow(/leaves the host's materials reflecting false/);
  });

  it("fails a host whose materials keep reflecting after ibl: null", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ ibl: "always-reflects" }) };
    await expect(find("ibl spec").run(setup)).rejects.toThrow(/still reflecting true/);
  });

  it("fails a host whose applyLightEstimation readback does not match the resolved request", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ lightEstimation: "wrong-request" }) };
    await expect(find("light estimation").run(setup)).rejects.toThrow(/applyLightEstimation was reached with/);
  });

  it("fails a host that has light estimation but silently does nothing with it", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ lightEstimation: "silent" }) };
    await expect(find("light estimation").run(setup)).rejects.toThrow(
      /neither produced an estimate nor reported light estimation unavailable/,
    );
  });

  it("passes a host with no light estimation at all, treating it as legitimately unsupported", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ lightEstimation: "absent" }) };
    await expect(find("light estimation").run(setup)).resolves.toBeUndefined();
  });

  it("passes a host that reports light estimation unavailable instead of ever measuring anything", async () => {
    const setup = { ...reference(), ...referenceEnvironment({ lightEstimation: "unavailable" }) };
    await expect(find("light estimation").run(setup)).resolves.toBeUndefined();
  });
});

describe("native Environment host conformance kit, every failure path", () => {
  const cases = nativeEnvironmentHostConformanceCases();
  const find = (part: string) => cases.find((c) => c.name.includes(part))!;

  /** The reference setup, with one environment readback replaced. */
  function lying(read: Partial<NativeEnvironmentTestHost>) {
    const setup = reference();
    return { ...setup, environmentTest: { ...setup.environmentTest, ...read } };
  }

  it("fails a host that draws a slot other than it was handed", async () => {
    const base = reference();
    const setup = {
      ...base,
      environmentTest: {
        ...base.environmentTest,
        applied: (slot: Slot) => (slot === "ambient" ? { colour: [0, 0, 0], intensity: 0 } : base.environmentTest.applied(slot)),
      },
    };
    await expect(find("every slot").run(setup)).rejects.toThrow(/ambient: the host draws/);
  });

  it("fails a host that disturbs the ambient light under passthrough", async () => {
    const base = reference();
    const setup = { ...base, environmentTest: { ...base.environmentTest, applied: (slot: Slot) => (slot === "ambient" ? null : base.environmentTest.applied(slot)) } };
    await expect(find("passthrough suppresses").run(setup)).rejects.toThrow(/leave the ambient light alone/);
  });

  it("fails a host that does not bring the sky back", async () => {
    const base = reference();
    let passthroughOver = 0;
    const environment = {
      ...base.environment,
      applySky: (value: unknown) => {
        if (value === null) passthroughOver += 1;
        if (passthroughOver === 0 || value === null) base.environment.applySky(value as never);
      },
    };
    await expect(find("passthrough suppresses").run({ ...base, environment })).rejects.toThrow(/return unchanged/);
  });

  it("fails a host that misses a transition's in-between values", async () => {
    const base = reference();
    let calls = 0;
    const environment = {
      ...base.environment,
      applyAmbient: (value: unknown) => {
        calls += 1;
        if (calls === 1) base.environment.applyAmbient(value as never);
      },
    };
    await expect(find("in-between").run({ ...base, environment })).rejects.toThrow(/midway the host draws/);
  });

  it("fails a host that applies occlusion before passthrough, or not the remembered spec", async () => {
    await expect(find("occlusion").run(lying({ appliedOcclusion: () => ({ mode: "hard", scope: "all" }) as never }))).rejects.toThrow(/while passthrough was off/);
    // A host that never applies the spec it was handed when passthrough starts.
    await expect(find("occlusion").run(lying({ appliedOcclusion: () => null }))).rejects.toThrow(/expected the remembered/);
  });

  it("fails a host that keeps occlusion applied after it was cleared, and leaves a correct host clean for a second run", async () => {
    const base = reference();
    let applied: unknown = null;
    let calls = 0;
    const sticky = {
      ...base,
      environment: {
        ...base.environment,
        applyOcclusion: (spec: unknown) => {
          calls += 1;
          if (spec !== null) applied = spec;
        },
      },
      environmentTest: { ...base.environmentTest, appliedOcclusion: () => applied as never },
    };
    await expect(find("occlusion").run(sticky)).rejects.toThrow(/stayed applied/);
    expect(calls).toBeGreaterThan(0);
    const clean = reference();
    await find("occlusion").run(clean);
    expect(clean.environmentTest.appliedOcclusion()).toBeFalsy();
    await find("occlusion").run(clean);
  });

  it("loads the sky image the kit was given, and the kit name when none was", async () => {
    const skyCase = find("every sky kind");
    const srcsSeen = (setup: ReturnType<typeof reference>) => {
      const seen: string[] = [];
      const original = setup.environment.applySky.bind(setup.environment);
      setup.environment.applySky = (sky) => {
        if (sky?.kind === "texture") seen.push(sky.src);
        original(sky);
      };
      return seen;
    };
    const given = reference();
    const givenSeen = srcsSeen(given);
    await skyCase.run({ ...given, skySrc: "app://skies/noon.hdr" });
    expect(givenSeen).toEqual(["app://skies/noon.hdr"]);
    const bare = reference();
    const bareSeen = srcsSeen(bare);
    await skyCase.run(bare);
    expect(bareSeen).toEqual(["kit://sky.hdr"]);
  });

  it("fails every audio policy case on a host that sounds the wrong number of voices", async () => {
    const wrongCue = (cueId: string, count: number) => {
      const setup = reference();
      return { ...setup, audioTest: { voices: () => Array.from({ length: count }, (_, i) => ({ voiceId: i, cueId })) } };
    };
    await expect(find("overlap").run(wrongCue("rc-kit-overlap", 1))).rejects.toThrow(/expected 2/);
    await expect(find("ignore").run(wrongCue("rc-kit-ignore", 2))).rejects.toThrow(/first one only/);
    await expect(find("minIntervalMs").run(wrongCue("rc-kit-throttle", 2))).rejects.toThrow(/inside 200 ms/);
  });

  it("fails the throttle case on a host that drops a play after the window", async () => {
    const base = reference();
    let starts = 0;
    const audio = {
      ...base.audio,
      start: (request: NativeAudioVoiceRequest) => {
        starts += 1;
        if (starts === 1) base.audio.start(request);
      },
    };
    await expect(find("minIntervalMs").run({ ...base, audio })).rejects.toThrow(/was dropped/);
  });
});
