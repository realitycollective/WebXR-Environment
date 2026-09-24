import { afterEach, describe, expect, it } from "vitest";
import {
  NATIVE_HOST_GLOBAL,
  getAudioHost,
  getEnvironmentHost,
  getSensingHost,
} from "../src/native-types.js";
import { createFakeAudioHost, createFakeEnvironmentHost, createFakeSensingHost } from "./helpers.js";

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL];
});

describe("getEnvironmentHost", () => {
  it("returns an injected host without touching globalThis", () => {
    const injected = createFakeEnvironmentHost();
    expect(getEnvironmentHost(injected)).toBe(injected);
  });

  it("falls back to globalThis.__rcHost.environment", () => {
    const environment = createFakeEnvironmentHost();
    (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] = { environment };
    expect(getEnvironmentHost()).toBe(environment);
  });

  it("throws, naming the slice, when neither has one", () => {
    expect(() => getEnvironmentHost()).toThrow(/environment/);
    (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] = {};
    expect(() => getEnvironmentHost()).toThrow(/globalThis\.__rcHost\.environment/);
  });
});

describe("getAudioHost", () => {
  it("returns an injected host without touching globalThis", () => {
    const injected = createFakeAudioHost();
    expect(getAudioHost(injected)).toBe(injected);
  });

  it("falls back to globalThis.__rcHost.audio", () => {
    const audio = createFakeAudioHost();
    (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] = { audio };
    expect(getAudioHost()).toBe(audio);
  });

  it("throws, naming the slice, when neither has one", () => {
    expect(() => getAudioHost()).toThrow(/globalThis\.__rcHost\.audio/);
  });
});

describe("getSensingHost", () => {
  it("returns an injected host without touching globalThis", () => {
    const injected = createFakeSensingHost();
    expect(getSensingHost(injected)).toBe(injected);
  });

  it("falls back to globalThis.__rcHost.sensing", () => {
    const sensing = createFakeSensingHost();
    (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] = { sensing };
    expect(getSensingHost()).toBe(sensing);
  });

  it("returns undefined, never throwing, when neither has one", () => {
    expect(getSensingHost()).toBeUndefined();
    (globalThis as Record<string, unknown>)[NATIVE_HOST_GLOBAL] = {};
    expect(getSensingHost()).toBeUndefined();
  });
});
