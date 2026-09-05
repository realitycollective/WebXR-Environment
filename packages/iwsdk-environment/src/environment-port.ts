/**
 * `EnvironmentPort` for Meta IWSDK.
 *
 * ---------------------------------------------------------------------------
 * IT USES IWSDK'S OWN MACHINERY, NOT THREE.JS BEHIND ITS BACK
 * ---------------------------------------------------------------------------
 * The sky is a `DomeGradient` on the level root and the lights are
 * `AmbientLightComponent` and `DirectionalLightComponent` on entities.
 * Reaching past IWSDK to write `scene.background` or to `scene.add()` a light
 * would work right up until IWSDK's own `EnvironmentSystem` or `LightSystem`
 * disagreed - and one of the things IWSDK's environment system already does
 * correctly is hide authored backgrounds in an AR session, which is behaviour
 * worth inheriting rather than fighting.
 *
 * No geometry is created here. Every component this port touches is an IWSDK
 * platform facility with no app-side equivalent; a floor would be a mesh, and
 * meshes are the app's.
 *
 * Fog is the exception. IWSDK has no fog component, so it is set on
 * `world.scene` directly, with three.js's own `Fog` / `FogExp2` imported from
 * `@iwsdk/core` (the framework's rule - one three.js instance, reached through
 * the framework's re-export).
 *
 * ---------------------------------------------------------------------------
 * WRITING COMPONENT COLOURS
 * ---------------------------------------------------------------------------
 * A `Types.Color` or `Types.Vec3` field must be written through
 * `getVectorView`; `setValue` on one throws. Every colour write here goes
 * through `writeColour` for that reason - it is not a style choice.
 */
import {
  AmbientLightComponent,
  DirectionalLightComponent,
  DomeGradient,
  Fog,
  FogExp2,
  Quaternion,
  Transform,
  Vector3,
  type Entity,
  type World,
} from "@iwsdk/core";
import type {
  AmbientLightSpec,
  EnvironmentPort,
  FogSpec,
  KeyLightSpec,
  Rgb,
  SkySpec,
} from "@realitycollective/webxr-environment";
import { clamp01, lerpRgb } from "@realitycollective/webxr-environment";

export interface IWSDKEnvironmentPortOptions {
  /**
   * Where the light entities are parented. Defaults to the active level root,
   * which is also where the dome lives, so the whole environment is torn down
   * with the level.
   */
  readonly parent?: Entity;
  /** Dome brightness multiplier. Default 1. */
  readonly skyIntensity?: number;
}

/**
 * The narrowest thing a vector view is: elics types it as a union of every
 * typed array, and all these helpers need is indexed writes and a length.
 */
type NumericView = { [index: number]: number; readonly length: number };

/** Local -Z is where an IWSDK directional light points. */
const LIGHT_FORWARD = new Vector3(0, 0, -1);
const TEMP_DIRECTION = new Vector3();
const TEMP_QUATERNION = new Quaternion();

export class IWSDKEnvironmentPort implements EnvironmentPort {
  readonly #world: World;
  readonly #parent: Entity | undefined;
  readonly #skyIntensity: number;

  #domeEntity: Entity | null = null;
  #ambientEntity: Entity | null = null;
  #keyEntity: Entity | null = null;
  #fogKind: FogSpec["kind"] | null = null;

  constructor(world: World, options: IWSDKEnvironmentPortOptions = {}) {
    this.#world = world;
    this.#parent = options.parent;
    this.#skyIntensity = options.skyIntensity ?? 1;
  }

  applySky(sky: SkySpec | null): void {
    const root = this.#levelRoot();
    if (root === null) return;

    if (sky === null) {
      if (this.#domeEntity !== null && this.#domeEntity.hasComponent(DomeGradient)) {
        this.#domeEntity.removeComponent(DomeGradient);
      }
      this.#domeEntity = null;
      return;
    }

    if (this.#domeEntity !== root || !root.hasComponent(DomeGradient)) {
      if (!root.hasComponent(DomeGradient)) root.addComponent(DomeGradient);
      this.#domeEntity = root;
    }

    // IWSDK's dome is a Unity-style sky / equator / ground triple. A solid sky
    // is all three the same; a gradient reads its equator from the same ramp
    // the three.js adapter uses, so the two engines agree at the horizon
    // rather than only at the poles.
    if (sky.kind === "solid") {
      writeRgb(root.getVectorView(DomeGradient, "sky"), sky.colour);
      writeRgb(root.getVectorView(DomeGradient, "equator"), sky.colour);
      writeRgb(root.getVectorView(DomeGradient, "ground"), sky.colour);
    } else {
      const equator = lerpRgb(sky.bottom, sky.top, Math.pow(0.5, sky.exponent ?? 1));
      writeRgb(root.getVectorView(DomeGradient, "sky"), sky.top);
      writeRgb(root.getVectorView(DomeGradient, "equator"), equator);
      writeRgb(root.getVectorView(DomeGradient, "ground"), sky.bottom);
    }
    root.setValue(DomeGradient, "intensity", this.#skyIntensity);
    root.setValue(DomeGradient, "_needsUpdate", true);
  }

  applyFog(fog: FogSpec | null): void {
    const scene = this.#world.scene;
    if (fog === null) {
      scene.fog = null;
      this.#fogKind = null;
      return;
    }
    if (this.#fogKind !== fog.kind || scene.fog === null) {
      scene.fog =
        fog.kind === "linear"
          ? new Fog(rgbToHexNumber(fog.colour), fog.near, fog.far)
          : new FogExp2(rgbToHexNumber(fog.colour), fog.density);
      this.#fogKind = fog.kind;
      return;
    }
    const existing = scene.fog;
    existing.color.setHex(rgbToHexNumber(fog.colour));
    if (fog.kind === "linear" && existing instanceof Fog) {
      existing.near = fog.near;
      existing.far = fog.far;
    } else if (fog.kind === "exponential" && existing instanceof FogExp2) {
      existing.density = fog.density;
    }
  }

  applyAmbient(light: AmbientLightSpec | null): void {
    if (light === null) {
      this.#destroy("ambient");
      return;
    }
    const entity = this.#ensure("ambient");
    if (!entity.hasComponent(AmbientLightComponent)) {
      entity.addComponent(AmbientLightComponent);
    }
    writeRgb(entity.getVectorView(AmbientLightComponent, "color"), light.colour);
    entity.setValue(AmbientLightComponent, "intensity", light.intensity);
  }

  applyKeyLight(light: KeyLightSpec | null): void {
    if (light === null) {
      this.#destroy("key");
      return;
    }
    const entity = this.#ensure("key");
    if (!entity.hasComponent(DirectionalLightComponent)) {
      entity.addComponent(DirectionalLightComponent);
    }
    writeRgb(entity.getVectorView(DirectionalLightComponent, "color"), light.colour);
    entity.setValue(DirectionalLightComponent, "intensity", light.intensity);
    entity.setValue(DirectionalLightComponent, "castShadow", light.castShadow ?? false);

    // The spec names the direction light TRAVELS; the component emits along
    // the entity's local -Z, so the entity is rotated to face that way. A
    // zero-length direction would produce a NaN quaternion, so it falls back
    // to straight down.
    const [x, y, z] = light.direction;
    if (Math.hypot(x, y, z) === 0) TEMP_DIRECTION.set(0, -1, 0);
    else TEMP_DIRECTION.set(x, y, z).normalize();
    TEMP_QUATERNION.setFromUnitVectors(LIGHT_FORWARD, TEMP_DIRECTION);
    writeQuaternion(entity.getVectorView(Transform, "orientation"), TEMP_QUATERNION);
  }

  dispose(): void {
    this.applySky(null);
    this.applyFog(null);
    this.applyAmbient(null);
    this.applyKeyLight(null);
  }

  #levelRoot(): Entity | null {
    return this.#parent ?? this.#world.activeLevel?.value ?? null;
  }

  /** The light entities exist independently of the level, so this cannot fail. */
  #ensure(which: "ambient" | "key"): Entity {
    const existing = which === "ambient" ? this.#ambientEntity : this.#keyEntity;
    if (existing !== null) return existing;
    const parent = this.#levelRoot();
    const entity = this.#world.createTransformEntity(
      undefined,
      parent === null ? undefined : { parent },
    );
    if (which === "ambient") this.#ambientEntity = entity;
    else this.#keyEntity = entity;
    return entity;
  }

  #destroy(which: "ambient" | "key"): void {
    const entity = which === "ambient" ? this.#ambientEntity : this.#keyEntity;
    entity?.destroy();
    if (which === "ambient") this.#ambientEntity = null;
    else this.#keyEntity = null;
  }
}

/** `[r, g, b]` in 0..1 -> a packed 0xRRGGBB, for the three.js-side setters. */
function rgbToHexNumber(rgb: Rgb): number {
  const channel = (value: number) => Math.round(clamp01(value) * 255);
  return (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2]);
}

/**
 * Write an RGBA colour into a component's vector view.
 *
 * The VIEW is passed in rather than the component and field name, so every
 * call site keeps elics's own `getVectorView` typing - which checks that the
 * field exists AND that it is an array type. A helper that took the component
 * would have to erase those generics, and the first misspelled field name
 * would then reach a headset instead of the compiler.
 *
 * Alpha is always 1: the specs describe opaque colours. Writing index 3 of a
 * three-component view is a no-op in JavaScript rather than an error, so no
 * length check is needed for a component whose colour is a `Types.Vec3`.
 */
function writeRgb(view: NumericView, rgb: Rgb): void {
  view[0] = rgb[0];
  view[1] = rgb[1];
  view[2] = rgb[2];
  view[3] = 1;
}

/** As above, for a `Types.Vec4` orientation. */
function writeQuaternion(view: NumericView, quaternion: Quaternion): void {
  view[0] = quaternion.x;
  view[1] = quaternion.y;
  view[2] = quaternion.z;
  view[3] = quaternion.w;
}
