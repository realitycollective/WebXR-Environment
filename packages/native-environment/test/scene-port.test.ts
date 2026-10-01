/**
 * The scene management suite over the real `NativeScenePort` and the fake
 * `scenes` slice from `helpers.ts`, which behaves as a conforming native app
 * would. The inspector answers from that app's own records, by node key.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  createNativeScenes,
  NativeScenePort,
  sceneManagerContractCases,
  type SceneContractFixtures,
  type SceneContractHost,
} from "@realitycollective/native-environment";
import { createFakeScenesHost } from "./helpers.js";

function createHost(fixtures: SceneContractFixtures): SceneContractHost<string, string> {
  const app = createFakeScenesHost({ fixtures });
  const exists = (key: string) => app.nodes.get(key)?.destroyed === false;
  return {
    port: new NativeScenePort(app),
    inspect: {
      exists,
      isShown: (key) => app.isShown(key),
      isHitTestable: (key) => app.isShown(key),
      worldPosition: (key) => app.nodes.get(key)?.position ?? [Number.NaN, Number.NaN, Number.NaN],
      liveCount: () => app.liveCount(),
    },
  };
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__rcHost;
});

describe("SceneManager contract on native", () => {
  for (const contractCase of sceneManagerContractCases()) {
    it(contractCase.name, () => contractCase.run({ create: createHost }));
  }
});

describe("NativeScenePort", () => {
  it("reads the scenes slice off globalThis.__rcHost, and names it when it is missing", () => {
    expect(() => new NativeScenePort()).toThrow(/globalThis.__rcHost.scenes is not installed/);
    (globalThis as Record<string, unknown>).__rcHost = { scenes: createFakeScenesHost() };
    expect(() => new NativeScenePort()).not.toThrow();
  });

  it("routes build progress to the build that asked, and stops listening on dispose", async () => {
    const app = createFakeScenesHost();
    const port = new NativeScenePort(app);
    const progress: number[] = [];
    const building = port.build({ id: "slow", src: "contract://slow" }, true, (value) => progress.push(value));
    app.emitBuildProgress("slow", 0.25);
    app.emitBuildProgress("other", 0.5);
    await building;
    app.emitBuildProgress("slow", 0.75);
    expect(progress).toEqual([0.25]);
    port.dispose();
    expect(() => port.dispose()).not.toThrow();
  });

  it("works with a slice that has no progress listener", async () => {
    const port = new NativeScenePort(createFakeScenesHost({ onBuildProgress: false }));
    const scene = await port.build({ id: "lobby", src: "contract://lobby" }, true, () => {});
    expect(port.nodeIds(scene)).toEqual(["hud", "floor"]);
    port.dispose();
  });

  it("keeps the first key of a repeated id, and forgets a detached node", async () => {
    const app = createFakeScenesHost();
    const port = new NativeScenePort(app);
    const scene = await port.build({ id: "repeat", src: "contract://repeat" }, true, () => {});
    const twin = port.findNode(scene, "twin") as string;
    expect(app.nodes.get(twin)?.position).toEqual([5, 0, -1]);
    port.detachNode(scene, twin);
    expect(port.findNode(scene, "twin")).toBeNull();
    port.destroy(scene);
    expect(port.nodeIds(scene)).toEqual([]);
    expect(port.findNode(scene, "twin")).toBeNull();
    port.detachNode(scene, "no-such-node");
    expect(app.detachNode).toHaveBeenLastCalledWith(scene, "no-such-node");
  });

  it("hands the app a fresh copy of the pose", async () => {
    const app = createFakeScenesHost();
    const port = new NativeScenePort(app);
    const scene = await port.build({ id: "lobby", src: "contract://lobby" }, true, () => {});
    const pose = { position: [1, 2, 3] as const, orientation: [0, 0, 0, 1] as const };
    port.instantiate("ball", pose, scene, null);
    const sent = (app.instantiate as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[1] as typeof pose;
    expect(sent).toEqual(pose);
    expect(sent.position).not.toBe(pose.position);
    expect(sent.orientation).not.toBe(pose.orientation);
  });

  it("createNativeScenes wires a manager to the slice", async () => {
    const app = createFakeScenesHost();
    const { manager, port } = createNativeScenes(app);
    expect(port).toBeInstanceOf(NativeScenePort);
    manager.register([{ id: "lobby", src: "contract://lobby" }]);
    await manager.load("lobby");
    expect(app.liveCount()).toBe(3);
    manager.dispose();
    expect(app.liveCount()).toBe(0);
  });
});
