/**
 * A platform adapter only implements the core's contracts. Its public
 * surface matches the other adapters: the core, the three ports and their
 * setup helpers. Slice reading stays internal.
 */
import { describe, expect, it } from "vitest";
import * as core from "@realitycollective/webxr-environment";
import * as adapter from "../src/index.js";

describe("native-environment public surface", () => {
  it("adds only the ports and setup helpers every adapter has", () => {
    const added = Object.keys(adapter).filter((name) => !(name in core)).sort();
    expect(added).toEqual([
      "NativeAudioPort",
      "NativeEnvironmentPort",
      "NativeWorldSensingPort",
      "createNativeAudio",
      "createNativeEnvironment",
      "createNativeWorldSensing",
    ]);
  });
});
