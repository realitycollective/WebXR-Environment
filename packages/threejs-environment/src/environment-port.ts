/**
 * `EnvironmentPort` for plain three.js.
 *
 * The port owns every object it creates and nothing it did not. It never adds
 * a light the app already had, never reads the scene to decide what to do, and
 * puts everything it makes under one `Group` so that an app can see at a glance
 * what the environment is responsible for. `dispose()` removes and releases
 * exactly that group and the texture behind the sky.
 *
 * It creates no GEOMETRY. Everything here is a three.js facility that has no
 * app-side equivalent - `scene.background`, `scene.fog`, the two lights. A
 * floor is a mesh, so a floor is the app's.
 *
 * Objects are REUSED across calls - the director pushes a new value on every
 * frame of a transition, and rebuilding a `DirectionalLight` sixty times a
 * second to change its colour would be absurd. A rebuild happens only when
 * something structural moves, which today means the fog changing kind.
 */
import {
  AmbientLight,
  Color,
  DataTexture,
  DirectionalLight,
  Fog,
  FogExp2,
  Group,
  Object3D,
  SRGBColorSpace,
  Scene,
} from "three";
import type {
  AmbientLightSpec,
  EnvironmentPort,
  FogSpec,
  KeyLightSpec,
  Rgb,
  SkySpec,
} from "@realitycollective/webxr-environment";
import { createSkyTexture } from "./sky-texture.js";

export interface ThreeEnvironmentPortOptions {
  /** Where the lights are parented. Default: the scene. */
  readonly parent?: Object3D;
  /** Rows in the generated sky texture. Default 64. */
  readonly skyResolution?: number;
  /** How far from the origin the key light sits. Default 50 m. */
  readonly keyLightDistance?: number;
}

/** sRGB tuple -> a three.js colour in the renderer's working space. */
function applyRgb(target: Color, rgb: Rgb): Color {
  return target.setRGB(rgb[0], rgb[1], rgb[2], SRGBColorSpace);
}

export class ThreeEnvironmentPort implements EnvironmentPort {
  readonly #scene: Scene;
  readonly #parent: Object3D;
  readonly #group = new Group();
  readonly #skyResolution: number;
  readonly #keyLightDistance: number;

  #skyTexture: DataTexture | null = null;
  #ambient: AmbientLight | null = null;
  #key: DirectionalLight | null = null;
  #fogKind: FogSpec["kind"] | null = null;

  constructor(scene: Scene, options: ThreeEnvironmentPortOptions = {}) {
    this.#scene = scene;
    this.#parent = options.parent ?? scene;
    this.#skyResolution = options.skyResolution ?? 64;
    this.#keyLightDistance = options.keyLightDistance ?? 50;
    this.#group.name = "webxr-environment";
    this.#parent.add(this.#group);
  }

  /** The group holding everything this port created. Read-only in practice. */
  get root(): Group {
    return this.#group;
  }

  applySky(sky: SkySpec | null): void {
    if (sky === null) {
      this.#releaseSkyTexture();
      this.#scene.background = null;
      return;
    }
    if (sky.kind === "solid") {
      this.#releaseSkyTexture();
      this.#scene.background = applyRgb(new Color(), sky.colour);
      return;
    }
    // A gradient's colours move every frame of a transition, so the texture is
    // regenerated in place rather than reallocated.
    if (this.#skyTexture === null) {
      this.#skyTexture = createSkyTexture(sky, this.#skyResolution);
    } else {
      const refreshed = createSkyTexture(sky, this.#skyResolution);
      this.#skyTexture.image.data = refreshed.image.data;
      this.#skyTexture.needsUpdate = true;
      refreshed.dispose();
    }
    this.#scene.background = this.#skyTexture;
  }

  applyFog(fog: FogSpec | null): void {
    if (fog === null) {
      this.#scene.fog = null;
      this.#fogKind = null;
      return;
    }
    if (this.#fogKind !== fog.kind || this.#scene.fog === null) {
      this.#scene.fog =
        fog.kind === "linear"
          ? new Fog(applyRgb(new Color(), fog.colour), fog.near, fog.far)
          : new FogExp2(applyRgb(new Color(), fog.colour), fog.density);
      this.#fogKind = fog.kind;
      return;
    }
    const existing = this.#scene.fog;
    applyRgb(existing.color, fog.colour);
    if (fog.kind === "linear" && existing instanceof Fog) {
      existing.near = fog.near;
      existing.far = fog.far;
    } else if (fog.kind === "exponential" && existing instanceof FogExp2) {
      existing.density = fog.density;
    }
  }

  applyAmbient(light: AmbientLightSpec | null): void {
    if (light === null) {
      if (this.#ambient !== null) {
        this.#group.remove(this.#ambient);
        this.#ambient.dispose();
        this.#ambient = null;
      }
      return;
    }
    if (this.#ambient === null) {
      this.#ambient = new AmbientLight();
      this.#ambient.name = "webxr-environment:ambient";
      this.#group.add(this.#ambient);
    }
    applyRgb(this.#ambient.color, light.colour);
    this.#ambient.intensity = light.intensity;
  }

  applyKeyLight(light: KeyLightSpec | null): void {
    if (light === null) {
      if (this.#key !== null) {
        this.#group.remove(this.#key);
        this.#key.dispose();
        this.#key = null;
      }
      return;
    }
    if (this.#key === null) {
      this.#key = new DirectionalLight();
      this.#key.name = "webxr-environment:key";
      this.#group.add(this.#key);
      this.#group.add(this.#key.target);
    }
    applyRgb(this.#key.color, light.colour);
    this.#key.intensity = light.intensity;
    this.#key.castShadow = light.castShadow ?? false;
    // The spec gives the direction light TRAVELS; a three.js directional light
    // travels from its position toward its target, so the position is the
    // direction negated. A zero-length direction would put the light on top of
    // its target and produce NaNs, so it falls back to straight down.
    const [x, y, z] = light.direction;
    const length = Math.hypot(x, y, z);
    const scale = length > 0 ? this.#keyLightDistance / length : 0;
    if (scale === 0) this.#key.position.set(0, this.#keyLightDistance, 0);
    else this.#key.position.set(-x * scale, -y * scale, -z * scale);
    this.#key.target.position.set(0, 0, 0);
    this.#key.target.updateMatrixWorld();
  }

  dispose(): void {
    this.applySky(null);
    this.applyFog(null);
    this.applyAmbient(null);
    this.applyKeyLight(null);
    this.#parent.remove(this.#group);
    // Nothing is left in the group by the calls above, but a caller that
    // parented something here of its own would otherwise leak silently.
    this.#group.clear();
  }

  #releaseSkyTexture(): void {
    if (this.#skyTexture === null) return;
    if (this.#scene.background === this.#skyTexture) this.#scene.background = null;
    this.#skyTexture.dispose();
    this.#skyTexture = null;
  }
}
