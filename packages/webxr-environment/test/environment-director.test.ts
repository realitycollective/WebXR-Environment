import { describe, expect, it, vi } from "vitest";
import type { EnvironmentSpec } from "@realitycollective/webxr-environment";
import {
  EnvironmentDirector,
  STOCK_PRESETS,
  VOID,
} from "@realitycollective/webxr-environment";
import { MinimalEnvironmentPort, RecordingEnvironmentPort } from "./helpers.js";

const DAY: EnvironmentSpec = {
  sky: { kind: "gradient", top: [0, 0, 1], bottom: [1, 1, 1] },
  ambient: { colour: [1, 1, 1], intensity: 1 },
};
const DARK: EnvironmentSpec = {
  sky: { kind: "gradient", top: [0, 0, 0], bottom: [0, 0, 0] },
  ambient: { colour: [0, 0, 0], intensity: 0 },
};

function setup(options: ConstructorParameters<typeof EnvironmentDirector>[1] = {}) {
  const port = new RecordingEnvironmentPort();
  const director = new EnvironmentDirector(port, options);
  return { port, director };
}

describe("EnvironmentDirector", () => {
  it("pushes every slot once on construction, even when empty", () => {
    // An adapter is entitled to assume the port describes the whole world, so
    // a scene carrying a leftover background from elsewhere gets cleared.
    const { port } = setup();
    expect(port.calls.map((call) => call.slot)).toEqual(["sky", "fog", "ambient", "key"]);
    expect(port.calls.every((call) => call.value === null)).toBe(true);
  });

  it("applies an initial spec", () => {
    const { port, director } = setup({ initial: DAY });
    expect(port.last("sky")).toEqual(DAY.sky);
    expect(director.current.ambient).toEqual(DAY.ambient);
  });

  it("treats an omitted slot as inherit and an explicit null as off", () => {
    const { port, director } = setup({ initial: DAY });
    port.clear();

    director.apply({ fog: { kind: "linear", colour: [0, 0, 0], near: 1, far: 2 } });
    expect(director.current.sky).toEqual(DAY.sky);
    expect(port.forSlot("sky")).toHaveLength(0);

    director.apply({ sky: null });
    expect(director.current.sky).toBeNull();
    expect(port.last("sky")).toBeNull();
  });

  it("pushes only the slots that changed", () => {
    const { port, director } = setup({ initial: DAY });
    port.clear();
    director.apply({ ambient: { colour: [1, 1, 1], intensity: 0.5 } });
    expect(port.calls.map((call) => call.slot)).toEqual(["ambient"]);
  });

  it("does not push, or notify, when nothing changed", () => {
    const { port, director } = setup({ initial: DAY });
    const listener = vi.fn();
    director.onChange(listener);
    port.clear();
    director.apply(DAY);
    expect(port.calls).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("resolves preset names, and says which are defined when one is missing", () => {
    const { director } = setup({ presets: STOCK_PRESETS });
    expect(director.presetNames()).toContain("dusk");
    expect(director.preset("dusk")).toBe(STOCK_PRESETS.dusk);
    expect(director.preset("nope")).toBeUndefined();
    director.apply("night");
    expect(director.current.sky).toEqual(STOCK_PRESETS.night?.sky);
    expect(() => director.apply("nope")).toThrow(/unknown preset "nope".*dawn/s);
  });

  it("reports no defined presets rather than an empty list", () => {
    const { director } = setup();
    expect(() => director.apply("nope")).toThrow(/defined: none/);
  });

  it("defines presets after construction", () => {
    const { director } = setup();
    director.define("mine", VOID);
    director.apply("mine");
    expect(director.current.ambient).toEqual(VOID.ambient);
  });

  describe("transitions", () => {
    it("eases between two environments over the requested duration", () => {
      const { director } = setup({ initial: DAY });
      director.transition(DARK, { durationMs: 1000 });
      expect(director.transitioning).toBe(true);

      director.update(500);
      expect(director.current.ambient).toEqual({ colour: [0.5, 0.5, 0.5], intensity: 0.5 });

      director.update(500);
      expect(director.current.ambient).toEqual(DARK.ambient);
      expect(director.transitioning).toBe(false);
    });

    it("pushes the t=0 frame immediately, so a snapping slot switches at once", () => {
      const { port, director } = setup({ initial: DAY });
      port.clear();
      director.transition({ fog: { kind: "linear", colour: [1, 1, 1], near: 1, far: 2 } }, {
        durationMs: 1000,
      });
      // Fog appearing cannot interpolate, so it is already there before the
      // first `update` - the alternative is one frame of nothing.
      expect(port.last("fog")).toEqual({ kind: "linear", colour: [1, 1, 1], near: 1, far: 2 });
    });

    it("applies immediately when the duration is zero or negative", () => {
      const { director } = setup({ initial: DAY });
      director.transition(DARK, { durationMs: 0 });
      expect(director.transitioning).toBe(false);
      expect(director.current.ambient).toEqual(DARK.ambient);

      director.transition(DAY, { durationMs: -5 });
      expect(director.current.ambient).toEqual(DAY.ambient);
    });

    it("falls back to the director's default transition", () => {
      const { director } = setup({ initial: DAY, defaultTransition: { durationMs: 400 } });
      director.transition(DARK);
      expect(director.transitioning).toBe(true);
      director.update(400);
      expect(director.current.ambient).toEqual(DARK.ambient);
    });

    it("uses the default easing when the call site names none", () => {
      const { director } = setup({
        initial: DAY,
        defaultTransition: { durationMs: 1000, easing: "easeIn" },
      });
      director.transition(DARK);
      director.update(500);
      // easeIn(0.5) = 0.25, so a quarter of the way from 1 to 0.
      expect(director.current.ambient?.intensity).toBeCloseTo(0.75);
    });

    it("eases from where it is when interrupted, rather than jumping", () => {
      const { director } = setup({ initial: DAY });
      director.transition(DARK, { durationMs: 1000 });
      director.update(500);
      director.transition(DAY, { durationMs: 1000 });
      // Half way back to full brightness from the interrupted midpoint.
      director.update(500);
      expect(director.current.ambient?.intensity).toBeCloseTo(0.75);
    });

    it("is cancelled outright by apply", () => {
      const { director } = setup({ initial: DAY });
      director.transition(DARK, { durationMs: 1000 });
      director.apply(DAY);
      expect(director.transitioning).toBe(false);
      director.update(1000);
      expect(director.current.ambient).toEqual(DAY.ambient);
    });

    it("jumps to the end on finish, and finish is a no-op otherwise", () => {
      const { director } = setup({ initial: DAY });
      director.finish();
      expect(director.current.ambient).toEqual(DAY.ambient);

      director.transition(DARK, { durationMs: 10_000 });
      director.finish();
      expect(director.transitioning).toBe(false);
      expect(director.current.ambient).toEqual(DARK.ambient);
    });

    it("ignores update while nothing is transitioning", () => {
      const { port, director } = setup({ initial: DAY });
      port.clear();
      director.update(16);
      expect(port.calls).toHaveLength(0);
    });
  });

  describe("passthrough", () => {
    it("suppresses the sky and fog without losing what was asked for", () => {
      const { port, director } = setup({
        initial: { ...DAY, fog: { kind: "linear", colour: [0, 0, 0], near: 1, far: 2 } },
      });
      port.clear();

      director.setPassthrough(true);
      expect(port.last("sky")).toBeNull();
      expect(port.last("fog")).toBeNull();
      // The ask is unchanged - nothing has to remember what to restore.
      expect(director.current.sky).toEqual(DAY.sky);
      expect(director.applied.sky).toBeNull();

      director.setPassthrough(false);
      expect(port.last("sky")).toEqual(DAY.sky);
    });

    it("leaves the lighting alone, because virtual content still needs lighting", () => {
      const { port, director } = setup({ initial: DAY });
      port.clear();
      director.setPassthrough(true);
      expect(port.forSlot("ambient")).toHaveLength(0);
      expect(director.applied.ambient).toEqual(DAY.ambient);
    });

    it("honours a custom suppression list", () => {
      const { port, director } = setup({
        initial: DAY,
        passthroughSuppresses: ["ambient"],
      });
      port.clear();
      director.setPassthrough(true);
      expect(port.last("ambient")).toBeNull();
      expect(port.forSlot("sky")).toHaveLength(0);
    });

    it("can start in passthrough", () => {
      const port = new RecordingEnvironmentPort();
      new EnvironmentDirector(port, { initial: DAY, passthrough: true });
      expect(port.last("sky")).toBeNull();
      expect(port.last("ambient")).toEqual(DAY.ambient);
    });

    it("ignores a repeated set", () => {
      const { port, director } = setup({ initial: DAY });
      director.setPassthrough(true);
      port.clear();
      director.setPassthrough(true);
      expect(port.calls).toHaveLength(0);
      expect(director.passthrough).toBe(true);
    });
  });

  describe("listeners", () => {
    it("reports both what the port holds and what was asked for", () => {
      const { director } = setup({ initial: DAY });
      const listener = vi.fn();
      director.onChange(listener);

      director.setPassthrough(true);
      expect(listener).toHaveBeenCalledTimes(1);
      const [applied, requested] = listener.mock.calls[0] as [
        { sky: unknown },
        { sky: unknown },
      ];
      expect(applied.sky).toBeNull();
      expect(requested.sky).toEqual(DAY.sky);
    });

    it("unsubscribes", () => {
      const { director } = setup({ initial: DAY });
      const listener = vi.fn();
      director.onChange(listener)();
      director.apply(DARK);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("disposal", () => {
    it("disposes the port and refuses further work", () => {
      const { port, director } = setup({ initial: DAY });
      director.transition(DARK, { durationMs: 1000 });
      director.dispose();

      expect(port.disposed).toBe(true);
      expect(director.transitioning).toBe(false);
      expect(() => director.apply(DAY)).toThrow(/disposed/);
      expect(() => director.transition(DAY)).toThrow(/disposed/);
      expect(() => director.finish()).toThrow(/disposed/);
      expect(() => director.setPassthrough(true)).toThrow(/disposed/);
      // `update` stays silent: it is called from a render loop that may well
      // outlive the teardown by a frame, and throwing there helps nobody.
      expect(() => director.update(16)).not.toThrow();
    });

    it("is idempotent, and tolerates a port with no dispose", () => {
      const port = new MinimalEnvironmentPort();
      const director = new EnvironmentDirector(port);
      director.dispose();
      director.dispose();
      expect(port.skies).toBe(1);
    });
  });

  it("reports an empty applied environment before the first flush completes", () => {
    // `applied` is only ever null inside the constructor, so this pins the
    // fallback rather than a reachable state - a getter that could return null
    // would push that null into every adapter.
    const { director } = setup();
    expect(director.applied).toEqual(director.current);
  });
});
