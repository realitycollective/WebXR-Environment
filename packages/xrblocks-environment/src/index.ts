/**
 * `@realitycollective/xrblocks-environment` - the Google XR Blocks adapter.
 *
 * EXPERIMENTAL, in the same sense as the other XR Blocks adapters in this
 * estate: it is written against the SHAPE of XR Blocks rather than importing
 * it, and XR Blocks is moving quickly.
 *
 * It re-exports the three.js adapter, which re-exports the engine-free core,
 * so an app on XR Blocks installs this package and nothing else.
 */
import type { Scene } from "three";
import type { ThreeEnvironmentPortOptions, ThreeScenePortOptions } from "@realitycollective/threejs-environment";
import type {
  AudioDirectorOptions,
  EnvironmentDirectorOptions,
} from "@realitycollective/webxr-environment";
import type { SceneManagerOptions, WorldSensingDirectorOptions } from "@realitycollective/webxr-environment";
import {
  AudioDirector,
  EnvironmentDirector,
  SceneManager,
  WorldSensingDirector,
} from "@realitycollective/webxr-environment";
import { ThreeAudioPort, ThreeScenePort, type ThreeAudioPortOptions } from "@realitycollective/threejs-environment";
import type { AudioListener, Group, Object3D } from "three";
import { XRBlocksEnvironmentPort } from "./environment-port.js";
import { XRBlocksWorldSensingPort } from "./world-sensing-port.js";
import type { XRBlocksEnvironmentContext, XBWorldLike } from "./xrblocks.js";

export type { XRBlocksEnvironmentContext } from "./xrblocks.js";
export type {
  ColourLike,
  Vec3Like,
  XBDepthLike,
  XBDepthOptionsLike,
  XBLightingLike,
  XBLightingOptionsLike,
} from "./xrblocks.js";
export { XRBlocksEnvironmentPort, estimatedFromLighting } from "./environment-port.js";
export { XRBlocksWorldSensingPort } from "./world-sensing-port.js";
export type {
  XBDetectedMeshLike,
  XBDetectedPlaneLike,
  XBMeshDetectorLike,
  XBObject3DLike,
  XBPlaneDetectorLike,
  XBWorldLike,
} from "./xrblocks.js";

export * from "@realitycollective/threejs-environment";

export interface XRBlocksEnvironmentSetup {
  readonly director: EnvironmentDirector;
  readonly port: XRBlocksEnvironmentPort;
}

/**
 * Wire an environment director to an XR Blocks scene.
 *
 * ```ts
 * const { director } = createXRBlocksEnvironment(xb.core.scene, {
 *   depth: xb.core.depth,
 *   lighting: xb.core.lighting,
 * }, { presets: STOCK_PRESETS });
 *
 * director.setPassthrough(true);
 * director.setOcclusion(DEFAULT_OCCLUSION);
 * director.setLightEstimation(true);
 * // then, from the XR Blocks script's own update:
 * director.update(deltaMs);
 * ```
 *
 * The director does not tick itself, and on this host that matters more than
 * on the others: both sensors are polled from `update`.
 */
export function createXRBlocksEnvironment(
  scene: Scene,
  context: XRBlocksEnvironmentContext,
  options: EnvironmentDirectorOptions & ThreeEnvironmentPortOptions = {},
): XRBlocksEnvironmentSetup {
  const port = new XRBlocksEnvironmentPort(scene, context, options);
  return { director: new EnvironmentDirector(port, options), port };
}

export interface XRBlocksWorldSensingSetup {
  readonly director: WorldSensingDirector;
  readonly port: XRBlocksWorldSensingPort;
}

/**
 * Wire a world-sensing director to XR Blocks' world module.
 *
 * ```ts
 * const { director: world } = createXRBlocksWorldSensing(xb.core.world, {
 *   detection: { planes: true, meshes: true },
 * });
 * ```
 *
 * Planes and meshes come from XR Blocks' own detectors, which have to be
 * enabled in its options before init. Anchors and hit testing are reported as
 * unsupported: XR Blocks places objects for you rather than answering where a
 * ray lands.
 */
export function createXRBlocksWorldSensing(
  world: XBWorldLike,
  options: WorldSensingDirectorOptions = {},
): XRBlocksWorldSensingSetup {
  const port = new XRBlocksWorldSensingPort(world);
  return { director: new WorldSensingDirector(port, options), port };
}

export interface XRBlocksAudioSetup {
  readonly director: AudioDirector;
  readonly port: ThreeAudioPort;
}

/**
 * Wire an audio director to an XR Blocks scene.
 *
 * XR Blocks has its own sound module, with its own category volumes and its
 * own spatial audio. This uses the three.js `AudioListener` path instead, for
 * one reason: an app that switches hosts keeps the same cue ids, the same bus
 * mix and the same retrigger policy. An app already invested in XR Blocks'
 * sound module should keep it and not use this.
 */
export function createXRBlocksAudio(
  listener: AudioListener,
  options: AudioDirectorOptions & ThreeAudioPortOptions = {},
): XRBlocksAudioSetup {
  const port = new ThreeAudioPort(listener, options);
  return { director: new AudioDirector(port, options), port };
}

export interface XRBlocksScenesSetup {
  readonly manager: SceneManager<Group, Object3D>;
  readonly port: ThreeScenePort;
}

/**
 * Wire a scene manager to XR Blocks' three.js scene (`xb.core.scene`). XR
 * Blocks renders through three.js and adds nothing a scene needs, so this is
 * `ThreeScenePort` outright, the same way `createXRBlocksAudio` is
 * `ThreeAudioPort`.
 */
export function createXRBlocksScenes(
  root: Object3D,
  options: SceneManagerOptions & ThreeScenePortOptions = {},
): XRBlocksScenesSetup {
  const port = new ThreeScenePort(root, options);
  return { manager: new SceneManager(port, options), port };
}
