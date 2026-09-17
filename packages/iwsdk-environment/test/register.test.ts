import { afterEach, describe, expect, it, vi } from "vitest";
import { AudioUtils, DomeGradient } from "@iwsdk/core";
import {
  environmentFor,
  EnvironmentSystem,
  IWSDKAudioPort,
  IWSDKEnvironmentPort,
  NIGHT,
  NOON,
  registerEnvironment,
  STOCK_PRESETS,
} from "@realitycollective/iwsdk-environment";
import { asWorld, createFakeWorld, type FakeWorld } from "./helpers.js";

function stubAudioUtils() {
  vi.spyOn(AudioUtils, "play").mockImplementation(() => {});
  vi.spyOn(AudioUtils, "stop").mockImplementation(() => {});
  vi.spyOn(AudioUtils, "setVolume").mockImplementation(() => {});
  vi.spyOn(AudioUtils, "isPlaying").mockImplementation(() => false);
}

function level(world: FakeWorld) {
  const root = world.activeLevel.value;
  if (root === null) throw new Error("no level");
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("registerEnvironment", () => {
  it("wires an environment director with no audio by default", () => {
    const world = createFakeWorld();
    const setup = registerEnvironment(asWorld(world), {
      presets: STOCK_PRESETS,
      initial: NIGHT,
    });

    expect(setup.environmentPort).toBeInstanceOf(IWSDKEnvironmentPort);
    expect(setup.audio).toBeNull();
    expect(setup.audioPort).toBeNull();
    expect(level(world).hasComponent(DomeGradient)).toBe(true);
  });

  it("wires audio when asked", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const setup = registerEnvironment(asWorld(world), {
      audio: { cues: [{ id: "hum", src: "/audio/hum.mp3", loop: true }] },
    });

    expect(setup.audioPort).toBeInstanceOf(IWSDKAudioPort);
    expect(setup.audio?.play("hum")).not.toBeNull();
  });

  it("returns the same setup for a world it has already wired", () => {
    const world = createFakeWorld();
    const first = registerEnvironment(asWorld(world));
    const second = registerEnvironment(asWorld(world), { initial: NOON });
    expect(second).toBe(first);
    expect(environmentFor(asWorld(world))).toBe(first);
  });

  it("forgets the world on dispose, so a later register starts clean", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const setup = registerEnvironment(asWorld(world), { audio: {} });
    setup.dispose();

    expect(environmentFor(asWorld(world))).toBeUndefined();
    expect(registerEnvironment(asWorld(world))).not.toBe(setup);
  });

  it("reports nothing for a world that was never wired", () => {
    expect(environmentFor(asWorld(createFakeWorld()))).toBeUndefined();
  });

  it("registers the tick system on the world", () => {
    const world = createFakeWorld();
    registerEnvironment(asWorld(world));
    expect(world.registeredSystems).toEqual([EnvironmentSystem]);
  });

  it("ticks both directors from the system's update, in seconds", () => {
    // IWSDK hands systems a delta in SECONDS and the directors take
    // milliseconds. Getting that wrong makes an eight-second dusk take two and
    // a quarter hours, which is exactly the kind of thing nobody notices until
    // it is on a headset.
    stubAudioUtils();
    const world = createFakeWorld();
    const setup = registerEnvironment(asWorld(world), {
      presets: STOCK_PRESETS,
      initial: NOON,
      audio: {},
    });

    setup.environment.transition("night", { durationMs: 1000 });
    // The system reads its world through `this.world`, so it is driven here
    // exactly as IWSDK's scheduler would drive it, minus the scheduler.
    const system = Object.create(EnvironmentSystem.prototype) as {
      world: unknown;
      update(delta: number): void;
    };
    system.world = world;

    system.update(0.5);
    expect(setup.environment.transitioning).toBe(true);
    system.update(0.5);
    expect(setup.environment.transitioning).toBe(false);
    expect(setup.environment.current.ambient).toEqual(NIGHT.ambient);
  });

  it("does nothing when its world was never registered", () => {
    const orphan = Object.create(EnvironmentSystem.prototype) as {
      world: unknown;
      update(delta: number): void;
    };
    orphan.world = createFakeWorld();
    expect(() => orphan.update(0.5)).not.toThrow();
  });

  it("passes passthrough through to the port as a suppression", () => {
    const world = createFakeWorld();
    const setup = registerEnvironment(asWorld(world), { initial: NOON });

    setup.environment.setPassthrough(true);
    expect(level(world).hasComponent(DomeGradient)).toBe(false);
    expect(setup.environment.current.sky).toEqual(NOON.sky);

    setup.environment.setPassthrough(false);
    expect(level(world).hasComponent(DomeGradient)).toBe(true);
  });
});
