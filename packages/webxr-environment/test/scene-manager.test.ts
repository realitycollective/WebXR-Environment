/**
 * SceneManager paths the shared suite does not reach: the errors it throws,
 * the races between a build and whatever happens while it runs, and the
 * bookkeeping around bindings and persistent instances.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentDirector,
  PERSISTENT_SCENE_ID,
  SCENE_CONTRACT_FIXTURES,
  SceneManager,
  type EnvironmentPort,
  type SceneDefinition,
} from "../src/index.js";
import { createMemoryHost, type MemoryNode } from "./scene-host.js";

const SCENES: readonly SceneDefinition[] = [
  { id: "lobby", src: "contract://lobby", environment: { sky: { kind: "solid", colour: [1, 0, 0] } } },
  { id: "court", src: "contract://court" },
  { id: "slow", src: "contract://slow" },
  { id: "fast", src: "contract://fast" },
  { id: "broken", src: "contract://broken" },
  { id: "repeat", src: "contract://repeat" },
];
const POSE = { position: [1, 2, 3], orientation: [0, 0, 0, 1] } as const;

function setup() {
  const host = createMemoryHost(SCENE_CONTRACT_FIXTURES);
  const manager = new SceneManager<MemoryNode, MemoryNode>(host.port);
  manager.register(SCENES);
  return { host, manager };
}

function environmentPort(): EnvironmentPort {
  return { applySky() {}, applyFog() {}, applyAmbient() {}, applyKeyLight() {}, applyIbl() {} };
}

describe("SceneManager.register", () => {
  it("rejects the reserved persistent id and a repeated id, registering nothing from that call", () => {
    const { manager } = setup();
    expect(() => manager.register([{ id: PERSISTENT_SCENE_ID, src: "x" }])).toThrow(/reserved/);
    expect(() => manager.register([{ id: "new", src: "x" }, { id: "lobby", src: "y" }])).toThrow(/already/);
    expect(manager.list().map((def) => def.id)).not.toContain("new");
  });
});

describe("SceneManager load and unload", () => {
  it("reports progress clamped to 0..1, ending at exactly 1", async () => {
    const { manager } = setup();
    const progress: number[] = [];
    await manager.load("lobby", { onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([0, 1, 1]);
  });

  it("clamps progress below zero and NaN to zero", async () => {
    const host = createMemoryHost(SCENE_CONTRACT_FIXTURES);
    const port = {
      ...host.port,
      build: async (def: SceneDefinition, visible: boolean, onProgress: (value: number) => void) => {
        onProgress(-1);
        onProgress(Number.NaN);
        onProgress(0.5);
        return host.port.build(def, visible, () => {});
      },
    };
    const manager = new SceneManager(port);
    manager.register(SCENES);
    const progress: number[] = [];
    await manager.load("lobby", { onProgress: (value) => progress.push(value) });
    expect(progress).toEqual([0, 0, 0.5, 1]);
  });

  it("lets a failed load be tried again as a new load", async () => {
    const { manager } = setup();
    const first = manager.load("broken");
    await expect(first).rejects.toThrow(/fails/);
    const second = manager.load("broken");
    expect(second).not.toBe(first);
    await expect(second).rejects.toThrow(/fails/);
  });

  it("names the repeated node id", async () => {
    const { manager } = setup();
    await expect(manager.load("repeat")).rejects.toThrow(/repeats the node id "twin"/);
  });

  it("gives the old active scene up when a single load fails after unloading it", async () => {
    const { manager } = setup();
    const changes: string[] = [];
    manager.onActiveSceneChanged((from, to) => changes.push(`${String(from)}>${String(to)}`));
    await manager.load("lobby");
    await expect(manager.load("broken")).rejects.toThrow();
    expect(manager.getActiveScene()).toBeNull();
    await manager.load("lobby");
    await expect(manager.load("repeat")).rejects.toThrow();
    expect(changes).toEqual(["null>lobby", "lobby>null", "null>lobby", "lobby>null"]);
  });

  it("treats load, unload, load of one scene as two loads", async () => {
    const { host, manager } = setup();
    const first = manager.load("lobby");
    const gone = manager.unload("lobby");
    const second = manager.load("lobby");
    expect(second).not.toBe(first);
    await Promise.all([first, gone, second]);
    expect(host.built).toEqual(["lobby", "lobby"]);
    expect(manager.isLoaded("lobby")).toBe(true);
  });

  it("resolves an unload of a scene that is not loaded, and rejects one not in the list", async () => {
    const { manager } = setup();
    await expect(manager.unload("lobby")).resolves.toBeUndefined();
    await expect(manager.unload("nope")).rejects.toThrow(/not in the scene list/);
  });

  it("reports a loading scene as loading and not loaded", async () => {
    const { manager } = setup();
    const pending = manager.load("slow");
    await Promise.resolve();
    expect(manager.loaded()).toEqual([{ id: "slow", state: "loading", order: 0 }]);
    expect(manager.isLoaded("slow")).toBe(false);
    expect(manager.getNode("slow", "slow-node")).toBeNull();
    await pending;
    expect(manager.isLoaded("slow")).toBe(true);
  });

  it("stops calling a listener once it unsubscribes", async () => {
    const { manager } = setup();
    const loaded = vi.fn();
    const unloaded = vi.fn();
    manager.onSceneLoaded(loaded)();
    manager.onSceneUnloaded(unloaded)();
    await manager.load("lobby");
    await manager.unload("lobby");
    expect(loaded).not.toHaveBeenCalled();
    expect(unloaded).not.toHaveBeenCalled();
  });

  it("an additive load makes itself active when nothing is", async () => {
    const { manager } = setup();
    await manager.load("court", { mode: "additive" });
    expect(manager.getActiveScene()).toBe("court");
  });
});

describe("SceneManager.activate", () => {
  it("throws for a scene that is not built, and does nothing for one already shown", async () => {
    const { manager } = setup();
    expect(() => manager.activate("lobby")).toThrow(/not built/);
    await manager.load("lobby");
    expect(() => manager.activate("lobby")).not.toThrow();
  });

  it("makes an activated additive scene active when asked to, or when nothing is active", async () => {
    const { manager } = setup();
    await manager.load("lobby", { mode: "additive", activate: false });
    manager.activate("lobby");
    expect(manager.getActiveScene()).toBe("lobby");
    await manager.load("court", { mode: "additive", activate: false, makeActive: true });
    manager.activate("court");
    expect(manager.getActiveScene()).toBe("court");
  });

  it("drops a scene still loading when a preloaded single load is activated", async () => {
    const { host, manager } = setup();
    await manager.load("lobby", { activate: false });
    const slow = manager.load("slow", { mode: "additive" });
    await Promise.resolve();
    manager.activate("lobby");
    await expect(slow).rejects.toThrow(/removed before it finished loading/);
    expect(manager.loaded().map((scene) => scene.id)).toEqual(["lobby"]);
    expect(host.inspect.liveCount()).toBe(3);
  });

  it("surfaces an error a binding throws at activate, after activating", async () => {
    const { manager } = setup();
    await manager.load("court", { mode: "additive", activate: false });
    manager.bindNode("court", "tee", () => {
      throw new Error("bind broke");
    });
    expect(() => manager.activate("court")).toThrow(/bind broke/);
    expect(manager.loaded()[0]?.state).toBe("loaded");
  });
});

describe("SceneManager active scene", () => {
  it("refuses to make a scene active that is not shown", async () => {
    const { manager } = setup();
    expect(() => manager.setActiveScene("lobby")).toThrow(/not loaded and shown/);
    await manager.load("court", { mode: "additive", activate: false });
    expect(() => manager.setActiveScene("court")).toThrow(/not loaded and shown/);
  });

  it("does not transition or notify when the active scene is set to itself", async () => {
    const director = new EnvironmentDirector(environmentPort());
    const transition = vi.spyOn(director, "transition");
    const host = createMemoryHost(SCENE_CONTRACT_FIXTURES);
    const manager = new SceneManager(host.port, { environment: director });
    manager.register(SCENES);
    await manager.load("lobby");
    const changes = vi.fn();
    manager.onActiveSceneChanged(changes);
    manager.setActiveScene("lobby");
    expect(changes).not.toHaveBeenCalled();
    expect(transition).toHaveBeenCalledTimes(1);
  });
});

describe("SceneManager instances", () => {
  it("needs a scene when none is active, and a built one", async () => {
    const { manager } = setup();
    expect(() => manager.instantiate("ball", POSE)).toThrow(/no scene is active/);
    expect(() => manager.instantiate("ball", POSE, { scene: "lobby" })).toThrow(/not built/);
  });

  it("parents to a node, takes a given id, and refuses a taken one", async () => {
    const { host, manager } = setup();
    await manager.load("lobby");
    const id = manager.instantiate("ball", POSE, { parentNode: "hud", id: "b1" });
    expect(id).toBe("b1");
    expect(manager.getNode("lobby", "b1")?.parent).toBe(manager.getNode("lobby", "hud"));
    expect(() => manager.instantiate("ball", POSE, { id: "b1" })).toThrow(/already/);
    expect(() => manager.instantiate("ball", POSE, { id: "floor" })).toThrow(/already/);
    expect(() => manager.instantiate("ball", POSE, { parentNode: "nope" })).toThrow(/no node "nope"/);
    expect(host.inspect.liveCount()).toBe(4);
  });

  it("skips a generated id that is already taken", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    manager.instantiate("ball", POSE, { id: "ball#1" });
    expect(manager.instantiate("ball", POSE)).toBe("ball#2");
  });

  it("destroys a persistent instance, and ignores unknown ids and persistent scene nodes", async () => {
    const { host, manager } = setup();
    await manager.load("lobby");
    const id = manager.instantiate("ball", POSE);
    manager.makePersistent("lobby", id);
    const released = vi.fn();
    manager.bindNode(PERSISTENT_SCENE_ID, id, () => released);
    manager.makePersistent("lobby", "hud");
    const count = host.inspect.liveCount();
    manager.destroy("hud");
    manager.destroy("nope");
    expect(host.inspect.liveCount()).toBe(count);
    manager.destroy(id);
    expect(released).toHaveBeenCalledTimes(1);
    expect(host.inspect.liveCount()).toBe(count - 1);
    expect(manager.getNode(PERSISTENT_SCENE_ID, id)).toBeNull();
  });

  it("releases an instance's bindings when it is destroyed", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    const id = manager.instantiate("ball", POSE);
    const released = vi.fn();
    manager.bindNode("lobby", id, () => released);
    manager.destroy(id);
    expect(released).toHaveBeenCalledTimes(1);
  });
});

describe("SceneManager nodes and persistence", () => {
  it("throws for a node it cannot find", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    expect(() => manager.setNodeActive("lobby", "nope", false)).toThrow(/no node "nope" in scene "lobby"/);
    expect(() => manager.bindNode(PERSISTENT_SCENE_ID, "nope", () => {})).toThrow(/no node/);
  });

  it("moves a node out of its scene's address, and refuses a second persistent node of that id", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    await manager.load("court", { mode: "additive" });
    const released = vi.fn();
    manager.bindNode("lobby", "hud", () => released);
    manager.makePersistent("lobby", "hud");
    manager.makePersistent(PERSISTENT_SCENE_ID, "hud");
    expect(manager.getNode("lobby", "hud")).toBeNull();
    expect(manager.getNode(PERSISTENT_SCENE_ID, "hud")).not.toBeNull();
    expect(() => manager.instantiate("ball", POSE, { id: "hud" })).toThrow(/already/);
    await manager.unload("lobby");
    expect(released).not.toHaveBeenCalled();
    await manager.load("lobby", { mode: "additive" });
    expect(() => manager.makePersistent("lobby", "hud")).toThrow(/already exists/);
  });

  it("binds with a binder that returns nothing, and unbinds before release", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    const unbind = manager.bindNode("lobby", "hud", () => undefined);
    expect(() => unbind()).not.toThrow();
    const release = vi.fn();
    const second = manager.bindNode("lobby", "floor", () => release);
    second();
    second();
    expect(release).toHaveBeenCalledTimes(1);
    await manager.unload("lobby");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("runs a waiting binding when its node is made persistent out of a preloaded scene", async () => {
    const { manager } = setup();
    await manager.load("court", { mode: "additive", activate: false });
    const bind = vi.fn();
    manager.bindNode("court", "tee", bind);
    manager.makePersistent("court", "tee");
    expect(bind).toHaveBeenCalledTimes(1);
    manager.makePersistent("court", "net");
  });

  it("drops a pending binding that is unbound before its scene is shown", async () => {
    const { manager } = setup();
    await manager.load("court", { mode: "additive", activate: false });
    const bind = vi.fn();
    manager.bindNode("court", "tee", bind)();
    manager.activate("court");
    expect(bind).not.toHaveBeenCalled();
  });

  it("finishes an unload whose binding release throws, then rejects with that error", async () => {
    const { host, manager } = setup();
    await manager.load("lobby");
    manager.bindNode("lobby", "hud", () => () => {
      throw new Error("release broke");
    });
    await expect(manager.unload("lobby")).rejects.toThrow(/release broke/);
    expect(manager.loaded()).toEqual([]);
    expect(host.inspect.liveCount()).toBe(0);
  });

  it("returns null from getNode once disposed", async () => {
    const { manager } = setup();
    await manager.load("lobby");
    manager.dispose();
    expect(manager.getNode("lobby", "hud")).toBeNull();
  });
});

describe("SceneManager.dispose", () => {
  it("rejects a load that is building or queued, destroying what it built", async () => {
    const { host, manager } = setup();
    const slow = manager.load("slow");
    const queued = manager.load("fast", { mode: "additive" });
    await Promise.resolve();
    manager.dispose();
    await expect(slow).rejects.toThrow(/removed before it finished loading/);
    await expect(queued).rejects.toThrow(/disposed/);
    expect(host.inspect.liveCount()).toBe(0);
    expect(host.port.disposed).toBe(1);
  });

  it("throws from every mutating call and hands out inert subscriptions", async () => {
    const { manager } = setup();
    manager.dispose();
    const unsubscribe = manager.onSceneLoaded(() => {});
    expect(() => unsubscribe()).not.toThrow();
    await expect(manager.unload("lobby")).rejects.toThrow(/disposed/);
    expect(() => manager.register([])).toThrow(/disposed/);
    expect(() => manager.activate("lobby")).toThrow(/disposed/);
    expect(() => manager.setActiveScene("lobby")).toThrow(/disposed/);
    expect(() => manager.setNodeActive("lobby", "hud", true)).toThrow(/disposed/);
    expect(() => manager.bindNode("lobby", "hud", () => {})).toThrow(/disposed/);
    expect(() => manager.instantiate("ball", POSE)).toThrow(/disposed/);
    expect(() => manager.destroy("x")).toThrow(/disposed/);
    expect(() => manager.makePersistent("lobby", "hud")).toThrow(/disposed/);
  });

  it("skips restoring the environment when the director was disposed first", async () => {
    const director = new EnvironmentDirector(environmentPort());
    const host = createMemoryHost(SCENE_CONTRACT_FIXTURES);
    const manager = new SceneManager(host.port, { environment: director });
    manager.register(SCENES);
    await manager.load("lobby");
    director.dispose();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("works on a port without dispose, and reports the first release error", async () => {
    const host = createMemoryHost(SCENE_CONTRACT_FIXTURES);
    const { dispose: _unused, ...port } = host.port;
    const manager = new SceneManager(port);
    manager.register(SCENES);
    await manager.load("lobby");
    manager.bindNode("lobby", "hud", () => () => {
      throw new Error("first");
    });
    manager.makePersistent("lobby", "floor");
    manager.bindNode(PERSISTENT_SCENE_ID, "floor", () => () => {
      throw new Error("second");
    });
    expect(() => manager.dispose()).toThrow(/first/);
    expect(host.inspect.liveCount()).toBe(0);
  });
});
