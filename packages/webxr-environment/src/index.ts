/**
 * `@realitycollective/webxr-environment` - the engine-free core.
 *
 * Install an ADAPTER (`threejs-environment`, `iwsdk-environment`) rather than
 * this package directly; each one re-exports everything here.
 */
export type {
  AmbientLightSpec,
  EnvironmentBlendMode,
  EnvironmentSlot,
  EnvironmentSpec,
  FogExponential,
  FogLinear,
  FogSpec,
  IblEstimated,
  IblGradient,
  IblRoom,
  IblSpec,
  IblTexture,
  KeyLightSpec,
  ResolvedEnvironment,
  Rgb,
  SkyGradient,
  SkySolid,
  SkySpec,
  SkyTexture,
  Vec3,
} from "./environment.js";
export { EMPTY_ENVIRONMENT, ENVIRONMENT_SLOTS } from "./environment.js";

export type {
  AudioBus,
  AudioCone,
  AudioCue,
  AudioSpatial,
  AudioVoice,
  AudioVoiceRequest,
  CuePolicy,
  PlayOptions,
} from "./audio.js";
export { DEFAULT_BUS, DEFAULT_BUSES } from "./audio.js";

export type { AudioPort, EnvironmentPort } from "./ports.js";

export type {
  OcclusionMode,
  OcclusionScope,
  OcclusionSource,
  OcclusionSpec,
} from "./occlusion.js";
export { DEFAULT_OCCLUSION } from "./occlusion.js";

export type { LightEstimationSpec, ResolvedLightEstimation } from "./light-estimation.js";
export { DEFAULT_LIGHT_ESTIMATION, resolveLightEstimation } from "./light-estimation.js";

export type {
  EnvironmentPortHost,
  EstimatedLighting,
  SensingFeature,
  SensingListener,
  SensingReport,
  SensingState,
} from "./sensing.js";
export { SENSING_FEATURES, unsupported } from "./sensing.js";

export type {
  HitTestRequest,
  Quat,
  ResolvedWorldDetection,
  WorldAnchor,
  WorldChange,
  WorldDetectionSpec,
  WorldFeature,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldPlaneOrientation,
  WorldPose,
} from "./world-sensing.js";
export {
  ALL_WORLD_DETECTION,
  resolveWorldDetection,
  WORLD_FEATURES,
  worldEntryChanged,
} from "./world-sensing.js";

export type {
  WorldChangeListener,
  WorldSensingDirectorOptions,
  WorldSensingPort,
  WorldSensingPortHost,
} from "./world-sensing-director.js";
export { WorldSensingDirector } from "./world-sensing-director.js";

export type {
  EnvironmentDirectorOptions,
  EnvironmentListener,
  TransitionOptions,
} from "./environment-director.js";
export { EnvironmentDirector } from "./environment-director.js";

export type {
  InstantiateOptions,
  LoadedScene,
  LoadedSceneState,
  SceneDefinition,
  SceneLoadMode,
  SceneLoadOptions,
  ScenePort,
} from "./scenes.js";
export { PERSISTENT_SCENE_ID } from "./scenes.js";

export type { SceneManagerOptions, SceneNodeBinder } from "./scene-manager.js";
export { SceneManager } from "./scene-manager.js";

export type {
  SceneContractFixtures,
  SceneContractHost,
  SceneContractInspector,
  SceneContractNode,
  SceneContractScene,
  SceneManagerContractCase,
  SceneManagerContractSubject,
} from "./scene-contract-cases.js";
export { SCENE_CONTRACT_FIXTURES, sceneManagerContractCases } from "./scene-contract-cases.js";

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

export type {
  AudioPortContractCase,
  AudioPortContractDriver,
  AudioPortContractSubject,
  EnvironmentPortContractCase,
  EnvironmentPortContractSubject,
  WorldSensingPortContractCase,
  WorldSensingPortContractSubject,
} from "./contract-cases.js";
export {
  audioPortContractCases,
  environmentPortContractCases,
  worldSensingPortContractCases,
} from "./contract-cases.js";
