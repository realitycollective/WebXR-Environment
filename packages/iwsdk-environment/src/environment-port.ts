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
  DepthOccludable,
  DepthSensingSystem,
  DirectionalLightComponent,
  DomeGradient,
  DomeTexture,
  IBLGradient,
  IBLTexture,
  OcclusionShadersMode,
  Transform,
  type Entity,
  type World,
} from "@iwsdk/core";
import { Fog, FogExp2, Quaternion, Vector3 } from "three";
import type {
  AmbientLightSpec,
  EnvironmentPort,
  EnvironmentPortHost,
  FogSpec,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  Rgb,
  SensingReport,
  SkyGradient,
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
  /** Dome brightness multiplier, used when a sky does not name its own. Default 1. */
  readonly skyIntensity?: number;
  /**
   * Which entities the real world is allowed to hide, for `scope: "all"`.
   *
   * IWSDK opts entities INTO occlusion one at a time, by patching the
   * materials under each one, so somebody has to say which entities those
   * are. It cannot be this port: the entities are content, content is the
   * app's, and walking a scene graph looking for meshes would be this package
   * guessing at the app's structure.
   *
   * With no list, `scope: "all"` reports `unavailable` and says why. An app
   * that would rather tag its own entities uses `scope: "tagged"` and adds
   * `DepthOccludable` itself; then this port only configures the system.
   */
  readonly occludables?: () => Iterable<Entity>;
}

/** 0..1 softness onto IWSDK's blur radius in pixels, whose default is 20. */
const MAX_BLUR_RADIUS = 40;

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

  readonly #occludables: (() => Iterable<Entity>) | undefined;

  #domeEntity: Entity | null = null;
  #iblEntity: Entity | null = null;
  #ambientEntity: Entity | null = null;
  #keyEntity: Entity | null = null;
  #fogKind: FogSpec["kind"] | null = null;
  #host: EnvironmentPortHost | null = null;
  /** Only what THIS port added, so it never removes the app's own component. */
  #occluding: Entity[] = [];

  constructor(world: World, options: IWSDKEnvironmentPortOptions = {}) {
    this.#world = world;
    this.#parent = options.parent;
    this.#skyIntensity = options.skyIntensity ?? 1;
    this.#occludables = options.occludables;
  }

  observe(host: EnvironmentPortHost): () => void {
    this.#host = host;
    return () => {
      this.#host = null;
    };
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

    if (sky.kind === "texture") {
      // An authored sky is a different IWSDK component, so the dome one goes
      // rather than sitting underneath and fighting over the same background.
      if (root.hasComponent(DomeGradient)) root.removeComponent(DomeGradient);
      if (!root.hasComponent(DomeTexture)) root.addComponent(DomeTexture);
      this.#domeEntity = root;
      root.setValue(DomeTexture, "src", sky.src);
      root.setValue(DomeTexture, "intensity", sky.intensity ?? this.#skyIntensity);
      root.setValue(DomeTexture, "blurriness", sky.blur ?? 0);
      writeVec3(root.getVectorView(DomeTexture, "rotation"), 0, sky.rotationY ?? 0, 0);
      root.setValue(DomeTexture, "_needsUpdate", true);
      return;
    }

    if (root.hasComponent(DomeTexture)) root.removeComponent(DomeTexture);
    if (this.#domeEntity !== root || !root.hasComponent(DomeGradient)) {
      if (!root.hasComponent(DomeGradient)) root.addComponent(DomeGradient);
      this.#domeEntity = root;
    }

    // IWSDK's dome is a Unity-style sky / equator / ground triple. A solid sky
    // is all three the same. A gradient uses the horizon colour the app gave,
    // and derives one from the ramp when it did not - which is the same colour
    // the three.js adapter puts at the horizon, so the two engines agree there
    // rather than only at the poles.
    if (sky.kind === "solid") {
      writeRgb(root.getVectorView(DomeGradient, "sky"), sky.colour);
      writeRgb(root.getVectorView(DomeGradient, "equator"), sky.colour);
      writeRgb(root.getVectorView(DomeGradient, "ground"), sky.colour);
      root.setValue(DomeGradient, "intensity", this.#skyIntensity);
    } else {
      writeRgb(root.getVectorView(DomeGradient, "sky"), sky.top);
      writeRgb(root.getVectorView(DomeGradient, "equator"), equatorOf(sky));
      writeRgb(root.getVectorView(DomeGradient, "ground"), sky.bottom);
      root.setValue(DomeGradient, "intensity", sky.intensity ?? this.#skyIntensity);
    }
    root.setValue(DomeGradient, "_needsUpdate", true);
  }

  /**
   * The environment map, as IWSDK's own image-based lighting components.
   *
   * `room` is not an approximation here: IWSDK's `IBLTexture` takes the string
   * `"room"` for its built-in probe, so the one kind three.js has to fake is
   * the one kind this host has natively.
   */
  applyIbl(ibl: IblSpec | null): void {
    const root = this.#levelRoot();
    if (root === null) return;

    if (ibl === null) {
      if (this.#iblEntity !== null) {
        if (this.#iblEntity.hasComponent(IBLGradient)) this.#iblEntity.removeComponent(IBLGradient);
        if (this.#iblEntity.hasComponent(IBLTexture)) this.#iblEntity.removeComponent(IBLTexture);
      }
      this.#iblEntity = null;
      return;
    }
    this.#iblEntity = root;

    if (ibl.kind === "estimated") {
      // IWSDK measures no reflections (UPSTREAM_ENHANCEMENTS 6.1), so the slot
      // keeps whatever it had rather than being cleared: an app that asked for
      // measured reflections and got none should not also lose its own map.
      this.#report({
        feature: "lightEstimation",
        state: "unsupported",
        detail: "IWSDK measures no reflections, so an estimated environment map cannot be applied",
      });
      return;
    }

    if (ibl.kind === "gradient") {
      if (root.hasComponent(IBLTexture)) root.removeComponent(IBLTexture);
      if (!root.hasComponent(IBLGradient)) root.addComponent(IBLGradient);
      writeRgb(root.getVectorView(IBLGradient, "sky"), ibl.top);
      writeRgb(root.getVectorView(IBLGradient, "equator"), equatorOf(ibl));
      writeRgb(root.getVectorView(IBLGradient, "ground"), ibl.bottom);
      root.setValue(IBLGradient, "intensity", ibl.intensity ?? 1);
      root.setValue(IBLGradient, "_needsUpdate", true);
      return;
    }

    if (root.hasComponent(IBLGradient)) root.removeComponent(IBLGradient);
    if (!root.hasComponent(IBLTexture)) root.addComponent(IBLTexture);
    root.setValue(IBLTexture, "src", ibl.kind === "room" ? "room" : ibl.src);
    root.setValue(IBLTexture, "intensity", ibl.intensity ?? 1);
    writeVec3(root.getVectorView(IBLTexture, "rotation"), 0, ibl.rotationY ?? 0, 0);
    root.setValue(IBLTexture, "_needsUpdate", true);
  }

  /**
   * Depth occlusion, through IWSDK's `DepthSensingSystem` and the per-entity
   * `DepthOccludable` component.
   *
   * IWSDK patches the materials under each opted-in entity, which is why the
   * scope matters more here than on three.js: there is no global mode to turn
   * on, and an entity nobody opted in is an entity the real world will not
   * hide. Whatever this port adds, it remembers, so turning occlusion off
   * never strips a component the app put there itself.
   */
  applyOcclusion(spec: OcclusionSpec | null): void {
    if (spec === null) {
      this.#releaseOccludables();
      const running = this.#system();
      if (running !== undefined) running.config.enableOcclusion.value = false;
      this.#report({ feature: "occlusion", state: "unavailable", detail: "occlusion is off" });
      return;
    }

    const blurRadius =
      spec.softness === undefined ? undefined : clamp01(spec.softness) * MAX_BLUR_RADIUS;
    const system = this.#system();
    if (system === undefined) {
      this.#world.registerSystem(DepthSensingSystem, {
        configData: {
          enableOcclusion: true,
          enableDepthTexture: true,
          useFloat32: spec.source?.format !== "luminance-alpha",
          ...(blurRadius === undefined ? {} : { blurRadius }),
        },
      });
    } else {
      system.config.enableOcclusion.value = true;
      system.config.useFloat32.value = spec.source?.format !== "luminance-alpha";
      if (blurRadius !== undefined) system.config.blurRadius.value = blurRadius;
    }

    const mode = occlusionMode(spec.mode);
    this.#releaseOccludables();
    if (spec.scope === "tagged") {
      this.#report({
        feature: "occlusion",
        state: "active",
        detail: "occluding the entities the app marked with DepthOccludable",
      });
      return;
    }
    if (this.#occludables === undefined) {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail:
          "IWSDK occludes per entity; pass an occludables option, or use scope: tagged and add DepthOccludable yourself",
      });
      return;
    }
    let count = 0;
    for (const entity of this.#occludables()) {
      if (entity.hasComponent(DepthOccludable)) continue;
      entity.addComponent(DepthOccludable, { mode });
      this.#occluding.push(entity);
      count += 1;
    }
    this.#report({
      feature: "occlusion",
      state: "active",
      detail: "occluding " + String(count) + " entities",
    });
  }

  /**
   * IWSDK 0.5.3 has no light estimation at all - no probe, no session hook,
   * nothing in its typings. This says so instead of leaving the app to wonder
   * why the room never lights anything, and the request is recorded in
   * docs/UPSTREAM_ENHANCEMENTS.md.
   */
  applyLightEstimation(estimation: ResolvedLightEstimation | null): void {
    if (estimation === null) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail: "light estimation is off",
      });
      return;
    }
    this.#report({
      feature: "lightEstimation",
      state: "unsupported",
      detail: "IWSDK 0.5.3 does not expose WebXR light estimation",
    });
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
    this.applyIbl(null);
    this.#releaseOccludables();
    this.#host = null;
  }

  #system() {
    return this.#world.getSystem(DepthSensingSystem);
  }

  #releaseOccludables(): void {
    for (const entity of this.#occluding) {
      if (entity.hasComponent(DepthOccludable)) entity.removeComponent(DepthOccludable);
    }
    this.#occluding = [];
  }

  #report(report: SensingReport): void {
    this.#host?.report(report);
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

/**
 * The colour at the horizon: the app's, or the one the ramp implies.
 *
 * IWSDK's dome and IBL components are both three-stop, so this port always has
 * to supply a middle colour. Deriving it from the same ramp the three.js
 * adapter draws is what stops the two engines disagreeing about a sky the app
 * described once.
 */
function equatorOf(gradient: SkyGradient | { top: Rgb; bottom: Rgb; equator?: Rgb }): Rgb {
  if (gradient.equator !== undefined) return gradient.equator;
  const exponent = "exponent" in gradient ? (gradient.exponent ?? 1) : 1;
  return lerpRgb(gradient.bottom, gradient.top, Math.pow(0.5, exponent));
}

/** Our mode names onto IWSDK's shader modes. */
function occlusionMode(mode: OcclusionSpec["mode"]): string {
  if (mode === "hard") return OcclusionShadersMode.HardOcclusion;
  if (mode === "minmax-soft") return OcclusionShadersMode.MinMaxSoftOcclusion;
  return OcclusionShadersMode.SoftOcclusion;
}

/** As `writeRgb`, for a `Types.Vec3` that is not a colour. */
function writeVec3(view: NumericView, x: number, y: number, z: number): void {
  view[0] = x;
  view[1] = y;
  view[2] = z;
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
