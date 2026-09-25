/**
 * The shipped scene management suite, tested against an in-memory host.
 *
 * The four platforms run these cases over their real ports, which proves they
 * pass there. This file proves the other half: each case passes on a host
 * that keeps the rules, and FAILS on a port or a manager built to break the
 * rule it checks. A case that cannot fail catches nothing.
 */
import { describe, expect, it } from "vitest";
import {
  SceneManager,
  sceneManagerContractCases,
  type SceneLoadOptions,
  type SceneManagerContractCase,
  type SceneManagerContractSubject,
  type SceneManagerOptions,
  type ScenePort,
} from "../src/index.js";
import { createMemoryHost, type MemoryHostBreaks, type MemoryNode } from "./scene-host.js";

type Port = ScenePort<MemoryNode, MemoryNode>;

function subject(
  breaks: MemoryHostBreaks = {},
  createManager?: (port: Port, options: SceneManagerOptions) => SceneManager<MemoryNode, MemoryNode>,
): SceneManagerContractSubject {
  return {
    create: (fixtures) => createMemoryHost(fixtures, breaks),
    ...(createManager === undefined ? {} : { createManager }),
  } as SceneManagerContractSubject;
}

function find(name: string): SceneManagerContractCase {
  const found = sceneManagerContractCases().find((entry) => entry.name.startsWith(name));
  if (found === undefined) throw new Error(`no scene contract case starting "${name}"`);
  return found;
}

class ReversedList extends SceneManager<MemoryNode, MemoryNode> {
  override list() {
    return [...super.list()].reverse();
  }
}

class AlwaysSingle extends SceneManager<MemoryNode, MemoryNode> {
  override load(id: string, options: SceneLoadOptions = {}) {
    return super.load(id, { ...options, mode: "single" });
  }
}

class ReversedStack extends SceneManager<MemoryNode, MemoryNode> {
  override loaded() {
    return [...super.loaded()].reverse();
  }
}

class Deaf extends SceneManager<MemoryNode, MemoryNode> {
  override onActiveSceneChanged() {
    return () => {};
  }
}

class PreloadAdditive extends SceneManager<MemoryNode, MemoryNode> {
  override load(id: string, options: SceneLoadOptions = {}) {
    return super.load(id, options.activate === false ? { ...options, mode: "additive" } : options);
  }
}

class Unordered extends SceneManager<MemoryNode, MemoryNode> {
  override async load(id: string, options: SceneLoadOptions = {}) {
    if (id === "slow") for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
    return super.load(id, options);
  }
}

class FreshPromises extends SceneManager<MemoryNode, MemoryNode> {
  override load(id: string, options: SceneLoadOptions = {}) {
    return super.load(id, options).then(() => {});
  }
}

/** A port that hides repeated ids from the manager, so a repeating scene loads. */
function hideRepeats(port: Port): Port {
  return { ...port, nodeIds: (scene) => [...new Set(port.nodeIds(scene))] };
}

const BREAKERS: readonly [string, SceneManagerContractSubject][] = [
  ["the scene list keeps registration order", subject({}, (port, options) => new ReversedList(port, options))],
  ["a single load unloads every loaded scene", subject({ leakNodes: true })],
  ["a single load keeps persistent nodes", subject({ ignoreDetach: true })],
  ["an additive load adds to the top", subject({}, (port, options) => new AlwaysSingle(port, options))],
  ["unload removes any scene in the stack", subject({}, (port, options) => new ReversedStack(port, options))],
  ["an unloaded scene takes its instances", subject({ keepInstances: true })],
  ["instantiate puts a new instance", subject({ spawnAtOrigin: true })],
  ["the active scene's environment", subject({}, (port) => new SceneManager(port, {}))],
  ["there is at most one active scene", subject({}, (port, options) => new Deaf(port, options))],
  ["a preloaded scene is built", subject({ showHidden: true })],
  ["a preloaded single load", subject({}, (port, options) => new PreloadAdditive(port, options))],
  ["loads and unloads run one at a time", subject({}, (port, options) => new Unordered(port, options))],
  ["a second load of a scene", subject({}, (port, options) => new FreshPromises(port, options))],
  ["a scene that repeats a node id", subject({}, (port, options) => new SceneManager(hideRepeats(port), options))],
  ["a scene the host cannot build", subject({ leakOnFailure: true })],
  ["a bound node resolves", subject({ wrongNode: true })],
  ["setNodeActive turns one node off", subject({ ignoreActive: true })],
  ["dispose leaves nothing on the host", subject({ keepDetached: true })],
];

describe("sceneManagerContractCases", () => {
  it("ships named cases, each with a run function, and a breaker for every one", () => {
    const cases = sceneManagerContractCases();
    expect(cases.length).toBe(BREAKERS.length);
    for (const contractCase of cases) {
      expect(typeof contractCase.name).toBe("string");
      expect(typeof contractCase.run).toBe("function");
      expect(BREAKERS.some(([prefix]) => contractCase.name.startsWith(prefix))).toBe(true);
    }
  });

  describe("pass on a host that keeps the rules", () => {
    for (const contractCase of sceneManagerContractCases()) {
      it(contractCase.name, () => contractCase.run(subject()));
    }
  });

  describe("fail on a port or manager built to break them", () => {
    for (const [prefix, broken] of BREAKERS) {
      it(prefix, async () => {
        await expect(find(prefix).run(broken)).rejects.toThrow();
      });
    }
  });

  it("find names a missing case", () => {
    expect(() => find("no such case")).toThrow(/no scene contract case/);
  });
});
