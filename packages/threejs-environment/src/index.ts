/**
 * `@realitycollective/threejs-environment` - the three.js adapter.
 *
 * Re-exports the whole engine-free core, so an app installs this package and
 * nothing else.
 */
import { AudioListener, Scene } from "three";
import type {
  AudioDirectorOptions,
  EnvironmentDirectorOptions,
} from "@realitycollective/webxr-environment";
import { AudioDirector, EnvironmentDirector } from "@realitycollective/webxr-environment";
import type { ThreeEnvironmentPortOptions } from "./environment-port.js";
import { ThreeEnvironmentPort } from "./environment-port.js";
import type { ThreeAudioPortOptions } from "./audio-port.js";
import { ThreeAudioPort } from "./audio-port.js";

export type { ThreeEnvironmentPortOptions } from "./environment-port.js";
export { ThreeEnvironmentPort } from "./environment-port.js";
export type { ThreeAudioPortOptions } from "./audio-port.js";
export { ThreeAudioPort } from "./audio-port.js";
export {
  createSkyTexture,
  gradientPixels,
  skyMix,
  SKY_TEXTURE_HEIGHT,
  SKY_TEXTURE_WIDTH,
} from "./sky-texture.js";

export * from "@realitycollective/webxr-environment";

export interface ThreeEnvironmentSetup {
  readonly director: EnvironmentDirector;
  readonly port: ThreeEnvironmentPort;
}

export interface ThreeAudioSetup {
  readonly director: AudioDirector;
  readonly port: ThreeAudioPort;
}

/**
 * Wire an environment director to a three.js scene.
 *
 * The director does not tick itself - call `director.update(deltaMs)` from
 * whatever already runs per frame.
 *
 * ```ts
 * const { director } = createThreeEnvironment(scene, { presets: STOCK_PRESETS });
 * director.transition("dusk", { durationMs: 8000, easing: "easeInOut" });
 * renderer.setAnimationLoop((_, __) => {
 *   director.update(clock.getDelta() * 1000);
 *   renderer.render(scene, camera);
 * });
 * ```
 */
export function createThreeEnvironment(
  scene: Scene,
  options: EnvironmentDirectorOptions & ThreeEnvironmentPortOptions = {},
): ThreeEnvironmentSetup {
  const port = new ThreeEnvironmentPort(scene, options);
  return { director: new EnvironmentDirector(port, options), port };
}

/**
 * Wire an audio director to a three.js `AudioListener` (the one on your
 * camera). Remember `port.resume()` from a user gesture.
 */
export function createThreeAudio(
  listener: AudioListener,
  options: AudioDirectorOptions & ThreeAudioPortOptions = {},
): ThreeAudioSetup {
  const port = new ThreeAudioPort(listener, options);
  return { director: new AudioDirector(port, options), port };
}
