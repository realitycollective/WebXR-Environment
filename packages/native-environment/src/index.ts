/**
 * `@realitycollective/native-environment` - the native host adapter.
 *
 * For an app embedding Hermes over OpenXR or CompositorServices, which owns
 * rendering and audio itself and installs `globalThis.__rcHost`. Re-exports
 * the whole engine-free core, so an app on a native host installs this
 * package and nothing else.
 *
 * Every `create*` helper here takes the host slice FIRST, mirroring
 * `createThreeEnvironment(scene, ...)` and `createXRBlocksAudio(listener,
 * ...)` in the sibling adapters - the one thing that differs per host, ahead
 * of the options every adapter shares. Leave it out and the port falls back
 * to `globalThis.__rcHost`, which is what a real native app installs.
 *
 * Like every adapter, it exports its ports, their setup helpers and the
 * structural types of what the host provides. Reading the slices off the
 * global stays internal.
 */
import type {
  AudioDirectorOptions,
  EnvironmentDirectorOptions,
  WorldSensingDirectorOptions,
} from "@realitycollective/webxr-environment";
import { AudioDirector, EnvironmentDirector, WorldSensingDirector } from "@realitycollective/webxr-environment";
import { NativeAudioPort } from "./audio-port.js";
import { NativeEnvironmentPort } from "./environment-port.js";
import { NativeWorldSensingPort } from "./world-sensing-port.js";
import type { NativeAudioHost, NativeEnvironmentHost, NativeSensingHost } from "./native-types.js";

export type {
  NativeAudioHost,
  NativeAudioVoiceRequest,
  NativeEnvironmentHost,
  NativeSensingHost,
} from "./native-types.js";
export { NativeEnvironmentPort } from "./environment-port.js";
export { NativeAudioPort } from "./audio-port.js";
export { NativeWorldSensingPort } from "./world-sensing-port.js";

export * from "@realitycollective/webxr-environment";

export interface NativeEnvironmentSetup {
  readonly director: EnvironmentDirector;
  readonly port: NativeEnvironmentPort;
}

/**
 * Wire an environment director to the native host's `environment` slice.
 *
 * ```ts
 * const { director } = createNativeEnvironment();   // reads globalThis.__rcHost.environment
 * director.transition("dusk", { durationMs: 8000, easing: "easeInOut" });
 * host.onFrame((_, deltaS) => director.update(deltaS * 1000));
 * ```
 *
 * Throws at construction when the host has no `environment` slice - see
 * `getEnvironmentHost`.
 */
export function createNativeEnvironment(
  host?: NativeEnvironmentHost,
  options: EnvironmentDirectorOptions = {},
): NativeEnvironmentSetup {
  const port = new NativeEnvironmentPort(host);
  return { director: new EnvironmentDirector(port, options), port };
}

export interface NativeAudioSetup {
  readonly director: AudioDirector;
  readonly port: NativeAudioPort;
}

/**
 * Wire an audio director to the native host's `audio` slice.
 *
 * Throws at construction when the host has no `audio` slice - see
 * `getAudioHost`.
 */
export function createNativeAudio(
  host?: NativeAudioHost,
  options: AudioDirectorOptions = {},
): NativeAudioSetup {
  const port = new NativeAudioPort(host);
  return { director: new AudioDirector(port, options), port };
}

export interface NativeWorldSensingSetup {
  readonly director: WorldSensingDirector;
  readonly port: NativeWorldSensingPort;
}

/**
 * Wire a world-sensing director to the native host's `sensing` slice.
 *
 * Never throws: `sensing` is the one slice this family treats as genuinely
 * optional, and a host without one is a `NativeWorldSensingPort` that reports
 * `unsupported` for everything rather than a construction error.
 */
export function createNativeWorldSensing(
  host?: NativeSensingHost,
  options: WorldSensingDirectorOptions = {},
): NativeWorldSensingSetup {
  const port = new NativeWorldSensingPort(host);
  return { director: new WorldSensingDirector(port, options), port };
}
