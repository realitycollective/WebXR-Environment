/**
 * `@realitycollective/webxr-environment` - the engine-free core.
 *
 * Install an ADAPTER (`threejs-environment`, `iwsdk-environment`) rather than
 * this package directly; each one re-exports everything here.
 */
export type {
  AmbientLightSpec,
  EnvironmentSlot,
  EnvironmentSpec,
  FogExponential,
  FogLinear,
  FogSpec,
  KeyLightSpec,
  ResolvedEnvironment,
  Rgb,
  SkyGradient,
  SkySolid,
  SkySpec,
  Vec3,
} from "./environment.js";
export { EMPTY_ENVIRONMENT, ENVIRONMENT_SLOTS } from "./environment.js";

export type {
  AudioBus,
  AudioCue,
  AudioVoice,
  AudioVoiceRequest,
  CuePolicy,
  PlayOptions,
} from "./audio.js";
export { DEFAULT_BUS, DEFAULT_BUSES } from "./audio.js";

export type { AudioPort, EnvironmentPort } from "./ports.js";

export type {
  EnvironmentDirectorOptions,
  EnvironmentListener,
  TransitionOptions,
} from "./environment-director.js";
export { EnvironmentDirector } from "./environment-director.js";

export type { AudioDirectorOptions } from "./audio-director.js";
export { AudioDirector } from "./audio-director.js";

export type { EasingFunction, EasingName } from "./math.js";
export {
  clamp,
  clamp01,
  lerp,
  lerpRgb,
  resolveEasing,
  rgbEquals,
  rgbFromHex,
  rgbToHex,
} from "./math.js";

export { deepEquals } from "./equality.js";
export { interpolateEnvironment } from "./interpolate.js";

export {
  clearedFog,
  DAWN,
  DUSK,
  NIGHT,
  NOON,
  OVERCAST,
  STOCK_PRESETS,
  VOID,
} from "./presets.js";
