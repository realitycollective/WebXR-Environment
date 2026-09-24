/**
 * The shipped conformance suites, tested against fakes.
 *
 * The four adapters run these cases for real, which proves they pass. This
 * file proves the other half: that each case FAILS when a port breaks the
 * promise it checks. A contract case that cannot fail is a case that catches
 * nothing, so every assertion inside `src/contract-cases.ts` gets a fake port
 * built to break it here - the same pattern `webxr-uiextensions` uses for its
 * own `contract-cases.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  audioPortContractCases,
  environmentPortContractCases,
  worldSensingPortContractCases,
  type AudioPort,
  type AudioPortContractDriver,
  type EnvironmentPort,
  type EnvironmentPortContractCase,
  type EnvironmentPortHost,
  type WorldSensingPort,
  type WorldSensingPortHost,
} from "../src/index.js";

/** Runs a case through an async wrapper, so a synchronous throw and a rejected promise look alike. */
async function invoke(run: () => unknown): Promise<void> {
  await run();
}

// ---------------------------------------------------------------------------
// EnvironmentPort
// ---------------------------------------------------------------------------

const APPLY_ALL = "applies every sky, fog, ambient, key and ibl variant, including null, without throwing";
const OBSERVE = "observe returns undefined or a function that can be called";
const OCCLUSION_REPORT = 'a port with applyOcclusion answers a request with a report for feature "occlusion"';
const LIGHT_REPORT =
  'a port with applyLightEstimation answers a request with a report for feature "lightEstimation"';
const KNOWN_REPORT = "every report uses a known feature and a known sensing state";
const ENV_DISPOSE = "dispose can be called twice";

interface FakeEnvironmentConfig {
  readonly throwOnApply?: boolean;
  readonly observe?: "ok" | "non-function" | "throwing-unsub";
  readonly occlusion?: "reports" | "absent" | "silent";
  readonly lightEstimation?: "reports" | "absent" | "silent";
  readonly extraBadFeatureReport?: boolean;
  readonly badStateReport?: boolean;
  readonly dispose?: "ok" | "absent" | "throws-twice";
}

function makeEnvironmentPort(config: FakeEnvironmentConfig = {}): EnvironmentPort {
  let host: EnvironmentPortHost | undefined;
  let disposedOnce = false;

  const port: EnvironmentPort = {
    applySky() {
      if (config.throwOnApply) throw new Error("applySky broke");
    },
    applyFog() {},
    applyAmbient() {},
    applyKeyLight() {},
    applyIbl() {},
    observe(h) {
      host = h;
      if (config.observe === "non-function") return 7 as unknown as () => void;
      if (config.observe === "throwing-unsub") {
        return () => {
          throw new Error("unsubscribe broke");
        };
      }
      return () => {};
    },
  };

  if ((config.occlusion ?? "reports") !== "absent") {
    port.applyOcclusion = () => {
      if (config.occlusion === "silent") return;
      host?.report({ feature: "occlusion", state: "active" });
      if (config.extraBadFeatureReport) {
        host?.report({ feature: "bogus-feature" as never, state: "active" });
      }
    };
  }
  if ((config.lightEstimation ?? "reports") !== "absent") {
    port.applyLightEstimation = () => {
      if (config.lightEstimation === "silent") return;
      // A real port also hands over a measurement; exercised here so the
      // recording host's `estimate` channel is not just declared but used.
      host?.estimate(null);
      host?.report({
        feature: "lightEstimation",
        state: config.badStateReport ? ("weird-state" as never) : "active",
      });
    };
  }
  if ((config.dispose ?? "ok") !== "absent") {
    port.dispose = () => {
      if (disposedOnce && config.dispose === "throws-twice") throw new Error("dispose broke");
      disposedOnce = true;
    };
  }
  return port;
}

function findEnvironmentCase(name: string): EnvironmentPortContractCase {
  const found = environmentPortContractCases().find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no contract case named "${name}"`);
  return found;
}

function runEnvironmentCase(name: string, config: FakeEnvironmentConfig): Promise<void> {
  return invoke(() => findEnvironmentCase(name).run({ port: makeEnvironmentPort(config) }));
}

describe("environmentPortContractCases", () => {
  it("ships named cases, each with a run function", () => {
    const cases = environmentPortContractCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const contractCase of cases) {
      expect(typeof contractCase.name).toBe("string");
      expect(typeof contractCase.run).toBe("function");
    }
    expect(environmentPortContractCases()).toBe(cases);
  });

  it("passes a conforming port", async () => {
    for (const contractCase of environmentPortContractCases()) {
      await expect(invoke(() => contractCase.run({ port: makeEnvironmentPort() }))).resolves.toBeUndefined();
    }
  });

  it("passes a port with none of the optional members", async () => {
    for (const contractCase of environmentPortContractCases()) {
      const port: EnvironmentPort = {
        applySky() {},
        applyFog() {},
        applyAmbient() {},
        applyKeyLight() {},
        applyIbl() {},
      };
      await expect(invoke(() => contractCase.run({ port }))).resolves.toBeUndefined();
    }
  });
});

describe("environmentPortContractCases catches a broken port", () => {
  it("rejects a port whose apply throws", async () => {
    await expect(runEnvironmentCase(APPLY_ALL, { throwOnApply: true })).rejects.toThrow(
      /applySky\(.*\) must not throw/,
    );
  });

  it("rejects an observe that returns something other than a function", async () => {
    await expect(runEnvironmentCase(OBSERVE, { observe: "non-function" })).rejects.toThrow(
      /must return undefined or a function/,
    );
  });

  it("rejects an unsubscribe that throws", async () => {
    await expect(runEnvironmentCase(OBSERVE, { observe: "throwing-unsub" })).rejects.toThrow(
      /the unsubscribe returned by observe\(\) threw/,
    );
  });

  it("rejects a port with applyOcclusion that never reports occlusion", async () => {
    await expect(runEnvironmentCase(OCCLUSION_REPORT, { occlusion: "silent" })).rejects.toThrow(
      /must produce at least one report for feature "occlusion"/,
    );
  });

  it("rejects a port with applyLightEstimation that never reports lightEstimation", async () => {
    await expect(runEnvironmentCase(LIGHT_REPORT, { lightEstimation: "silent" })).rejects.toThrow(
      /must produce at least one report for feature "lightEstimation"/,
    );
  });

  it("rejects a report with an unknown feature", async () => {
    await expect(runEnvironmentCase(KNOWN_REPORT, { extraBadFeatureReport: true })).rejects.toThrow(
      /unknown feature/,
    );
  });

  it("rejects a report with an unknown sensing state", async () => {
    await expect(runEnvironmentCase(KNOWN_REPORT, { badStateReport: true })).rejects.toThrow(
      /unknown state/,
    );
  });

  it("rejects a second dispose that throws", async () => {
    await expect(runEnvironmentCase(ENV_DISPOSE, { dispose: "throws-twice" })).rejects.toThrow(
      /second dispose\(\) must be a no-op/,
    );
  });

  it("fails loudly when asked for a case that does not exist", () => {
    expect(() => findEnvironmentCase("no such case")).toThrow(/no contract case named/);
  });
});

// ---------------------------------------------------------------------------
// AudioPort
// ---------------------------------------------------------------------------

const ONE_SHOT = "a one-shot's ended runs exactly once, immediately or when driven to end";
const LOOP_STOPS = "a looping voice can be stopped without throwing";
const STOP_GUARDS_END = "after stop, driving an end does not call ended";
const SET_GAIN = "setGain on a sounding voice does not throw, when it implements setGain";
const LOAD_RETURN = "load returns void or a promise, when it implements load";
const AUDIO_DISPOSE = "dispose can be called twice, when it implements dispose";

interface FakeAudioConfig {
  readonly oneShot?: "immediate" | "deferred" | "silent";
  readonly doubleEnded?: boolean;
  readonly stopThrows?: boolean;
  readonly stopCallsEndedItself?: boolean;
  readonly ignoreStopForEnd?: boolean;
  readonly setGain?: "ok" | "absent" | "throws";
  readonly load?: "ok" | "absent" | "invalid" | "promise";
  readonly dispose?: "ok" | "absent" | "throws-twice";
}

function makeAudioSubject(config: FakeAudioConfig = {}): { port: AudioPort; driver: AudioPortContractDriver } {
  const tracked = new Map<number, () => void>();
  let disposedOnce = false;

  const port: AudioPort = {
    start(request) {
      if (request.loop) {
        tracked.set(request.voiceId, request.ended);
        return;
      }
      const mode = config.oneShot ?? "immediate";
      if (mode === "silent") return;
      if (mode === "deferred") {
        tracked.set(request.voiceId, request.ended);
        return;
      }
      request.ended();
      if (config.doubleEnded) request.ended();
    },
    stop(voiceId) {
      if (config.stopThrows) throw new Error("stop broke");
      const ended = tracked.get(voiceId);
      if (!config.ignoreStopForEnd) tracked.delete(voiceId);
      if (config.stopCallsEndedItself) ended?.();
    },
  };

  if ((config.setGain ?? "ok") !== "absent") {
    port.setGain = () => {
      if (config.setGain === "throws") throw new Error("setGain broke");
    };
  }
  if ((config.load ?? "ok") !== "absent") {
    port.load = () => {
      if (config.load === "invalid") return 42 as unknown as void;
      if (config.load === "promise") return Promise.resolve();
      return undefined;
    };
  }
  if ((config.dispose ?? "ok") !== "absent") {
    port.dispose = () => {
      if (disposedOnce && config.dispose === "throws-twice") throw new Error("dispose broke");
      disposedOnce = true;
    };
  }

  const driver: AudioPortContractDriver = {
    end(voiceId) {
      const ended = tracked.get(voiceId);
      if (ended === undefined) return;
      tracked.delete(voiceId);
      ended();
      if (config.doubleEnded) ended();
    },
  };
  return { port, driver };
}

function findAudioCase(name: string) {
  const found = audioPortContractCases().find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no contract case named "${name}"`);
  return found;
}

function runAudioCase(name: string, config: FakeAudioConfig): Promise<void> {
  return invoke(() => findAudioCase(name).run(makeAudioSubject(config)));
}

describe("audioPortContractCases", () => {
  it("ships named cases, each with a run function", () => {
    const cases = audioPortContractCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const contractCase of cases) {
      expect(typeof contractCase.name).toBe("string");
      expect(typeof contractCase.run).toBe("function");
    }
    expect(audioPortContractCases()).toBe(cases);
  });

  it("passes a conforming port that ends one-shots immediately", async () => {
    for (const contractCase of audioPortContractCases()) {
      await expect(invoke(() => contractCase.run(makeAudioSubject()))).resolves.toBeUndefined();
    }
  });

  it("passes a conforming port that only ends one-shots when driven", async () => {
    for (const contractCase of audioPortContractCases()) {
      await expect(
        invoke(() => contractCase.run(makeAudioSubject({ oneShot: "deferred" }))),
      ).resolves.toBeUndefined();
    }
  });

  it("passes a conforming port whose load resolves a promise", async () => {
    const contractCase = findAudioCase(LOAD_RETURN);
    await expect(
      invoke(() => contractCase.run(makeAudioSubject({ load: "promise" }))),
    ).resolves.toBeUndefined();
  });

  it("passes a port with none of the optional members", async () => {
    for (const contractCase of audioPortContractCases()) {
      const tracked = new Map<number, () => void>();
      const port: AudioPort = {
        start(request) {
          if (request.loop) tracked.set(request.voiceId, request.ended);
          else request.ended();
        },
        stop(voiceId) {
          tracked.delete(voiceId);
        },
      };
      const driver: AudioPortContractDriver = {
        end(voiceId) {
          tracked.get(voiceId)?.();
          tracked.delete(voiceId);
        },
      };
      await expect(invoke(() => contractCase.run({ port, driver }))).resolves.toBeUndefined();
    }
  });
});

describe("audioPortContractCases catches a broken port", () => {
  it("rejects a one-shot that never calls ended", async () => {
    await expect(runAudioCase(ONE_SHOT, { oneShot: "silent" })).rejects.toThrow(
      /must call ended exactly once, it was called 0 time\(s\)/,
    );
  });

  it("rejects a one-shot whose ended fires twice", async () => {
    await expect(runAudioCase(ONE_SHOT, { oneShot: "deferred", doubleEnded: true })).rejects.toThrow(
      /must call ended exactly once, it was called 2 time\(s\)/,
    );
  });

  it("rejects a stop that throws on a looping voice", async () => {
    await expect(runAudioCase(LOOP_STOPS, { stopThrows: true })).rejects.toThrow(
      /stop\(\) on a looping voice must not throw/,
    );
  });

  it("rejects a stop that calls ended itself", async () => {
    await expect(runAudioCase(LOOP_STOPS, { stopCallsEndedItself: true })).rejects.toThrow(
      /stop\(\) must not call ended itself/,
    );
  });

  it("rejects a port that still calls ended after the voice was stopped", async () => {
    await expect(runAudioCase(STOP_GUARDS_END, { ignoreStopForEnd: true })).rejects.toThrow(
      /must not call ended/,
    );
  });

  it("rejects a setGain that throws", async () => {
    await expect(runAudioCase(SET_GAIN, { setGain: "throws" })).rejects.toThrow(
      /setGain\(\) on a sounding voice must not throw/,
    );
  });

  it("rejects a load that returns neither void nor a promise", async () => {
    await expect(runAudioCase(LOAD_RETURN, { load: "invalid" })).rejects.toThrow(
      /load\(\) must return void or a promise/,
    );
  });

  it("rejects a second dispose that throws", async () => {
    await expect(runAudioCase(AUDIO_DISPOSE, { dispose: "throws-twice" })).rejects.toThrow(
      /second dispose\(\) must be a no-op/,
    );
  });

  it("fails loudly when asked for a case that does not exist", () => {
    expect(() => findAudioCase("no such case")).toThrow(/no contract case named/);
  });
});

// ---------------------------------------------------------------------------
// WorldSensingPort
// ---------------------------------------------------------------------------

const WORLD_OBSERVE = "observe returns undefined or a function that can be called";
const SET_DETECTION = 'setDetection with planes on answers with a report for feature "planes", when it implements setDetection';
const START_HIT_TEST =
  'startHitTest answers with a report for feature "hitTest" or a call to hits(), when it implements startHitTest';
const CREATE_ANCHOR = "createAnchor resolves to a string or null and never rejects, when it implements createAnchor";
const UNKNOWN_IDS = "stopHitTest and removeAnchor on unknown ids do not throw";
const WORLD_KNOWN_REPORT = "every report uses a known feature and a known sensing state";
const WORLD_DISPOSE = "dispose can be called twice, when it implements dispose";

interface FakeWorldConfig {
  readonly observe?: "ok" | "non-function" | "throwing-unsub";
  readonly setDetection?: "reports" | "absent" | "silent";
  readonly startHitTest?: "reports" | "hits-only" | "absent" | "silent";
  readonly stopHitTestThrows?: boolean;
  readonly createAnchor?: "resolves-string" | "resolves-null" | "resolves-invalid" | "rejects" | "absent";
  readonly removeAnchorThrows?: boolean;
  readonly badFeatureReport?: boolean;
  readonly badStateReport?: boolean;
  readonly dispose?: "ok" | "absent" | "throws-twice";
}

function makeWorldSensingPort(config: FakeWorldConfig = {}): WorldSensingPort {
  let host: WorldSensingPortHost | undefined;
  let disposedOnce = false;

  const port: WorldSensingPort = {
    observe(h) {
      host = h;
      if (config.observe === "non-function") return 7 as unknown as () => void;
      if (config.observe === "throwing-unsub") {
        return () => {
          throw new Error("unsubscribe broke");
        };
      }
      return () => {};
    },
  };

  if ((config.setDetection ?? "reports") !== "absent") {
    port.setDetection = (detection) => {
      if (config.setDetection !== "silent") {
        if (detection?.planes) {
          host?.planes([]);
          host?.report({ feature: "planes", state: "pending" });
        }
        if (detection?.meshes) host?.meshes([]);
        if (detection?.anchors) host?.anchors([]);
      }
      if (config.badFeatureReport) host?.report({ feature: "bogus-feature" as never, state: "active" });
    };
  }
  if ((config.startHitTest ?? "reports") !== "absent") {
    port.startHitTest = (request) => {
      if (config.startHitTest === "hits-only") {
        host?.hits(request.id, []);
        return;
      }
      if (config.startHitTest !== "silent") {
        host?.report({
          feature: "hitTest",
          state: config.badStateReport ? ("weird-state" as never) : "pending",
        });
      }
    };
  }
  port.stopHitTest = () => {
    if (config.stopHitTestThrows) throw new Error("stopHitTest broke");
  };
  if ((config.createAnchor ?? "resolves-string") !== "absent") {
    port.createAnchor = async () => {
      if (config.createAnchor === "rejects") throw new Error("anchor refused");
      if (config.createAnchor === "resolves-invalid") return 42 as unknown as string;
      if (config.createAnchor === "resolves-null") return null;
      return "anchor-1";
    };
  }
  port.removeAnchor = () => {
    if (config.removeAnchorThrows) throw new Error("removeAnchor broke");
  };
  if ((config.dispose ?? "ok") !== "absent") {
    port.dispose = () => {
      if (disposedOnce && config.dispose === "throws-twice") throw new Error("dispose broke");
      disposedOnce = true;
    };
  }
  return port;
}

function findWorldCase(name: string) {
  const found = worldSensingPortContractCases().find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no contract case named "${name}"`);
  return found;
}

function runWorldCase(name: string, config: FakeWorldConfig): Promise<void> {
  return invoke(() => findWorldCase(name).run({ port: makeWorldSensingPort(config) }));
}

describe("worldSensingPortContractCases", () => {
  it("ships named cases, each with a run function", () => {
    const cases = worldSensingPortContractCases();
    expect(cases.length).toBeGreaterThan(0);
    for (const contractCase of cases) {
      expect(typeof contractCase.name).toBe("string");
      expect(typeof contractCase.run).toBe("function");
    }
    expect(worldSensingPortContractCases()).toBe(cases);
  });

  it("passes a conforming port", async () => {
    for (const contractCase of worldSensingPortContractCases()) {
      await expect(
        invoke(() => contractCase.run({ port: makeWorldSensingPort() })),
      ).resolves.toBeUndefined();
    }
  });

  it("passes a port with only observe implemented", async () => {
    for (const contractCase of worldSensingPortContractCases()) {
      const port: WorldSensingPort = { observe: () => {} };
      await expect(invoke(() => contractCase.run({ port }))).resolves.toBeUndefined();
    }
  });

  it("passes a conforming port whose createAnchor resolves null", async () => {
    const contractCase = findWorldCase(CREATE_ANCHOR);
    await expect(
      invoke(() => contractCase.run({ port: makeWorldSensingPort({ createAnchor: "resolves-null" }) })),
    ).resolves.toBeUndefined();
  });

  it("passes a conforming port whose startHitTest answers only through hits()", async () => {
    const contractCase = findWorldCase(START_HIT_TEST);
    await expect(
      invoke(() => contractCase.run({ port: makeWorldSensingPort({ startHitTest: "hits-only" }) })),
    ).resolves.toBeUndefined();
  });
});

describe("worldSensingPortContractCases catches a broken port", () => {
  it("rejects an observe that returns something other than a function", async () => {
    await expect(runWorldCase(WORLD_OBSERVE, { observe: "non-function" })).rejects.toThrow(
      /must return undefined or a function/,
    );
  });

  it("rejects an unsubscribe that throws", async () => {
    await expect(runWorldCase(WORLD_OBSERVE, { observe: "throwing-unsub" })).rejects.toThrow(
      /the unsubscribe returned by observe\(\) threw/,
    );
  });

  it('rejects a setDetection that never reports "planes"', async () => {
    await expect(runWorldCase(SET_DETECTION, { setDetection: "silent" })).rejects.toThrow(
      /must produce at least one report for feature "planes"/,
    );
  });

  it('rejects a startHitTest that never reports "hitTest" or calls hits()', async () => {
    await expect(runWorldCase(START_HIT_TEST, { startHitTest: "silent" })).rejects.toThrow(
      /must answer with a report for feature "hitTest" or a call to hits\(\)/,
    );
  });

  it("rejects a createAnchor that rejects", async () => {
    await expect(runWorldCase(CREATE_ANCHOR, { createAnchor: "rejects" })).rejects.toThrow(
      /must never reject/,
    );
  });

  it("rejects a createAnchor that resolves to neither a string nor null", async () => {
    await expect(runWorldCase(CREATE_ANCHOR, { createAnchor: "resolves-invalid" })).rejects.toThrow(
      /must resolve to a string or null/,
    );
  });

  it("rejects a stopHitTest that throws for an unknown id", async () => {
    await expect(runWorldCase(UNKNOWN_IDS, { stopHitTestThrows: true })).rejects.toThrow(
      /stopHitTest\(\) on an unknown id must not throw/,
    );
  });

  it("rejects a removeAnchor that throws for an unknown id", async () => {
    await expect(runWorldCase(UNKNOWN_IDS, { removeAnchorThrows: true })).rejects.toThrow(
      /removeAnchor\(\) on an unknown id must not throw/,
    );
  });

  it("rejects a report with an unknown feature", async () => {
    await expect(runWorldCase(WORLD_KNOWN_REPORT, { badFeatureReport: true })).rejects.toThrow(
      /unknown feature/,
    );
  });

  it("rejects a report with an unknown sensing state", async () => {
    await expect(runWorldCase(WORLD_KNOWN_REPORT, { badStateReport: true })).rejects.toThrow(
      /unknown state/,
    );
  });

  it("rejects a second dispose that throws", async () => {
    await expect(runWorldCase(WORLD_DISPOSE, { dispose: "throws-twice" })).rejects.toThrow(
      /second dispose\(\) must be a no-op/,
    );
  });

  it("fails loudly when asked for a case that does not exist", () => {
    expect(() => findWorldCase("no such case")).toThrow(/no contract case named/);
  });
});
