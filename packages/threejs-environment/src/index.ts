/**
 * `@realitycollective/threejs-environment` - the three.js adapter.
 *
 * Re-exports the whole engine-free core, so an app installs this package and
 * nothing else.
 */
import type { Group, Object3D } from "three";
import { AudioListener, Scene } from "three";
import type {
  AudioDirectorOptions,
  EnvironmentDirectorOptions,
  SceneManagerOptions,
} from "@realitycollective/webxr-environment";
import type { WorldSensingDirectorOptions } from "@realitycollective/webxr-environment";
import {
  AudioDirector,
  EnvironmentDirector,
  SceneManager,
  WorldSensingDirector,
} from "@realitycollective/webxr-environment";
import type { ThreeWorldSensingPortOptions } from "./world-sensing-port.js";
import { ThreeWorldSensingPort } from "./world-sensing-port.js";
import type { XrRendererLike } from "./xr.js";
import type { ThreeEnvironmentPortOptions } from "./environment-port.js";
import { ThreeEnvironmentPort } from "./environment-port.js";
import type { ThreeAudioPortOptions } from "./audio-port.js";
import { ThreeAudioPort } from "./audio-port.js";
import type { ThreeScenePortOptions } from "./scene-port.js";
import { ThreeScenePort } from "./scene-port.js";

export type { EquirectLoader, ThreeEnvironmentPortOptions } from "./environment-port.js";
export { ThreeEnvironmentPort } from "./environment-port.js";
export type { ThreeAudioPortOptions } from "./audio-port.js";
export { ThreeAudioPort } from "./audio-port.js";
export type { ThreeWorldSensingPortOptions } from "./world-sensing-port.js";
export { ThreeWorldSensingPort } from "./world-sensing-port.js";
export type { ThreeAssetFactory, ThreeSceneLoader, ThreeScenePortOptions } from "./scene-port.js";
export { ThreeScenePort } from "./scene-port.js";
export type { RampGradient } from "./sky-texture.js";
export {
  createSkyTexture,
  gradientColourAt,
  gradientPixels,
  skyMix,
  SKY_TEXTURE_HEIGHT,
  SKY_TEXTURE_WIDTH,
} from "./sky-texture.js";
export type {
  XrAnchorLike,
  XrFrameLike,
  XrHitTestResultLike,
  XrInputSourceLike,
  XrLightEstimateLike,
  XrLightProbeLike,
  XrManagerLike,
  XrMeshLike,
  XrPlaneLike,
  XrPoseLike,
  XrRendererLike,
  XrSessionLike,
} from "./xr.js";
export {
  ambientFromSphericalHarmonics,
  keyFromEstimate,
  toEstimatedLighting,
  SH_DC_TO_IRRADIANCE,
} from "./light-estimate.js";

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

export interface ThreeWorldSensingSetup {
  readonly director: WorldSensingDirector;
  readonly port: ThreeWorldSensingPort;
}

/**
 * Wire a world-sensing director to a three.js renderer.
 *
 * Separate from `createThreeEnvironment` on purpose: an app that only wants a
 * sky pays for none of this, and the two directors share nothing but the
 * vocabulary their reports are written in.
 *
 * ```ts
 * const { director: world } = createThreeWorldSensing(renderer, {
 *   detection: { planes: true },
 * });
 * world.onChange(({ feature, added }) => {
 *   if (feature === "planes") for (const id of added) console.log("new surface", id);
 * });
 * renderer.setAnimationLoop(() => {
 *   world.update(clock.getDelta() * 1000);   // this is where the frame is read
 *   renderer.render(scene, camera);
 * });
 * ```
 *
 * The session still has to be asked for `plane-detection`, `mesh-detection`,
 * `anchors` or `hit-test` when it is created - that is the platform layer's
 * job, not this package's - and the reports say plainly when it was not.
 */
export function createThreeWorldSensing(
  renderer: XrRendererLike,
  options: WorldSensingDirectorOptions & ThreeWorldSensingPortOptions = {},
): ThreeWorldSensingSetup {
  const port = new ThreeWorldSensingPort(renderer, options);
  return { director: new WorldSensingDirector(port, options), port };
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

export interface ThreeScenesSetup {
  readonly manager: SceneManager<Group, Object3D>;
  readonly port: ThreeScenePort;
}

/**
 * Wire a scene manager to a three.js root. Each loaded scene becomes a group
 * under `root`. Pass `environment` to let the active scene drive a director.
 *
 * ```ts
 * const { director } = createThreeEnvironment(scene);
 * const { manager } = createThreeScenes(scene, { environment: director, assets: (name) => prefabs[name].clone() });
 * manager.register([{ id: "court", src: "/scenes/court.glb", environment: "dusk" }]);
 * await manager.load("court");
 * ```
 */
export function createThreeScenes(
  root: Object3D,
  options: SceneManagerOptions & ThreeScenePortOptions = {},
): ThreeScenesSetup {
  const port = new ThreeScenePort(root, options);
  return { manager: new SceneManager(port, options), port };
}
