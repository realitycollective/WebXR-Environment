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
  EquirectangularReflectionMapping,
  Fog,
  FogExp2,
  Group,
  Object3D,
  SRGBColorSpace,
  Scene,
  Texture,
  TextureLoader,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type {
  AmbientLightSpec,
  EnvironmentPort,
  EnvironmentPortHost,
  EstimatedLighting,
  FogSpec,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  Rgb,
  SensingReport,
  SkySpec,
} from "@realitycollective/webxr-environment";
import { createSkyTexture } from "./sky-texture.js";
import { toEstimatedLighting } from "./light-estimate.js";
import type { XrLightProbeLike, XrRendererLike } from "./xr.js";

export interface ThreeEnvironmentPortOptions {
  /** Where the lights are parented. Default: the scene. */
  readonly parent?: Object3D;
  /** Rows in the generated sky texture. Default 64. */
  readonly skyResolution?: number;
  /** How far from the origin the key light sits. Default 50 m. */
  readonly keyLightDistance?: number;
  /**
   * The renderer, for the two sensor-backed features.
   *
   * Without it sky, fog, lighting and image-based lighting all work exactly as
   * before, and occlusion and light estimation report `unsupported` rather
   * than failing quietly. Only `renderer.xr` is ever touched.
   */
  readonly renderer?: XrRendererLike;
  /**
   * Resolves a texture `src`. Injected for tests; defaults to a `TextureLoader`.
   *
   * Typed as the one method rather than as `Pick<TextureLoader, "loadAsync">`,
   * because that spelling drags in three's `Texture<HTMLImageElement>` generic
   * and then nothing but a real `TextureLoader` fits - including an app's own
   * `RGBELoader`, which is the loader an HDR environment map actually needs.
   */
  readonly textureLoader?: EquirectLoader;
  /**
   * Turns a scene into a prefiltered environment map, for `ibl: { kind: "room" }`.
   *
   * Prefiltering is `PMREMGenerator.fromScene`, which needs a live renderer and
   * a GL context, so it cannot happen inside a port that is unit tested with
   * neither. Pass `(scene) => pmrem.fromScene(scene, 0.04).texture` to get
   * three.js's real room probe; leave it out and `room` falls back to a
   * neutral grey gradient, which is honest and costs nothing.
   */
  readonly prefilter?: (scene: Scene) => Texture;
  /**
   * Turns the session's light probe into a usable environment map.
   *
   * WebXR hands back a reflection cube map through
   * `new XRWebGLBinding(session, gl).getReflectionCubeMap(probe)`, which needs
   * the GL context this port does not hold - so the app supplies the two lines
   * that do it, and gets `ibl: { kind: "estimated" }` in return. Without it,
   * light estimation still delivers ambient and key, and says plainly that the
   * reflections were not measured.
   */
  readonly reflection?: (probe: XrLightProbeLike) => Texture | null;
}

/** Anything that can turn a URL into a texture: `TextureLoader`, `RGBELoader`. */
export interface EquirectLoader {
  loadAsync(url: string): Promise<Texture>;
}

/** The neutral ramp `ibl: { kind: "room" }` uses with no prefilter available. */
const NEUTRAL_ROOM = {
  kind: "gradient",
  top: [0.6, 0.6, 0.62],
  bottom: [0.28, 0.28, 0.3],
  equator: [0.45, 0.45, 0.46],
} as const;

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

  readonly #renderer: XrRendererLike | null;
  readonly #textureLoader: EquirectLoader;
  readonly #prefilter: ((scene: Scene) => Texture) | null;
  readonly #reflection: ((probe: XrLightProbeLike) => Texture | null) | null;

  #skyTexture: DataTexture | null = null;
  /** An image the port loaded for the sky, as opposed to one it generated. */
  #skyImage: Texture | null = null;
  #iblTexture: DataTexture | null = null;
  #iblImage: Texture | null = null;
  #ambient: AmbientLight | null = null;
  #key: DirectionalLight | null = null;
  #fogKind: FogSpec["kind"] | null = null;
  /** Bumped on every sky/ibl change so a slow load cannot overwrite a fast one. */
  #skyToken = 0;
  #iblToken = 0;
  #host: EnvironmentPortHost | null = null;
  #occlusion: OcclusionSpec | null = null;
  #occlusionActive = false;
  #estimation: ResolvedLightEstimation | null = null;
  #probe: XrLightProbeLike | null = null;
  #probeToken = 0;
  #estimating = false;
  /** The measured cube map, and whether the ibl slot is showing it. */
  #estimated: Texture | null = null;
  #iblIsEstimated = false;
  #saidNoReflection = false;

  constructor(scene: Scene, options: ThreeEnvironmentPortOptions = {}) {
    this.#scene = scene;
    this.#parent = options.parent ?? scene;
    this.#skyResolution = options.skyResolution ?? 64;
    this.#keyLightDistance = options.keyLightDistance ?? 50;
    this.#renderer = options.renderer ?? null;
    this.#textureLoader = options.textureLoader ?? new TextureLoader();
    this.#prefilter = options.prefilter ?? null;
    this.#reflection = options.reflection ?? null;
    this.#group.name = "webxr-environment";
    this.#parent.add(this.#group);
  }

  /** The group holding everything this port created. Read-only in practice. */
  get root(): Group {
    return this.#group;
  }

  applySky(sky: SkySpec | null): void {
    // Any change cancels a load already in flight. Without this an app that
    // switches skies twice in a second can end up with the first one, because
    // it happened to decode last.
    this.#skyToken += 1;
    if (sky === null) {
      this.#releaseSkyTexture();
      this.#scene.background = null;
      this.#scene.backgroundIntensity = 1;
      this.#scene.backgroundRotation.set(0, 0, 0);
      this.#scene.backgroundBlurriness = 0;
      return;
    }
    if (sky.kind === "solid") {
      this.#releaseSkyTexture();
      this.#scene.background = applyRgb(new Color(), sky.colour);
      this.#scene.backgroundIntensity = 1;
      this.#scene.backgroundBlurriness = 0;
      return;
    }
    if (sky.kind === "texture") {
      this.#releaseSkyTexture();
      this.#scene.backgroundIntensity = sky.intensity ?? 1;
      this.#scene.backgroundRotation.set(0, sky.rotationY ?? 0, 0);
      this.#scene.backgroundBlurriness = sky.blur ?? 0;
      const token = this.#skyToken;
      void this.#loadEquirect(sky.src).then((texture) => {
        if (texture === null) return;
        if (token !== this.#skyToken) {
          texture.dispose();
          return;
        }
        this.#skyImage = texture;
        this.#scene.background = texture;
      });
      return;
    }
    this.#scene.backgroundIntensity = sky.intensity ?? 1;
    this.#scene.backgroundRotation.set(0, 0, 0);
    this.#scene.backgroundBlurriness = 0;
    // A gradient's colours move every frame of a transition. The texture is
    // rebuilt and SWAPPED, not refilled in place: three.js turns an
    // equirectangular background into a cube map once per texture object and
    // keeps that cube map until the texture is disposed, so refilling the
    // pixels and flagging `needsUpdate` re-uploads the 2D texture that nothing
    // draws while the sky on screen stays at its first frame. Disposing the
    // old texture is what drops the cached cube map. The texture is a few
    // dozen rows, so the upload is cheap, and the cube conversion costs the
    // same either way.
    const previous = this.#skyTexture;
    this.#skyTexture = createSkyTexture(sky, this.#skyResolution);
    this.#scene.background = this.#skyTexture;
    previous?.dispose();
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

  /**
   * The environment map: what shiny things reflect, and what lights everything
   * the key light does not.
   *
   * Three kinds, three routes. A gradient is the same generated equirect the
   * sky uses, regenerated in place across a transition. An image is loaded
   * once and swapped in when it lands. A room is three.js's own
   * RoomEnvironment, which has to be prefiltered by a renderer this port does
   * not have - so it is used when the app supplied a prefilter, and
   * approximated with a neutral ramp when it did not.
   */
  applyIbl(ibl: IblSpec | null): void {
    this.#iblToken += 1;
    if (ibl === null) {
      this.#releaseIbl();
      this.#scene.environment = null;
      this.#scene.environmentIntensity = 1;
      this.#scene.environmentRotation.set(0, 0, 0);
      return;
    }
    this.#scene.environmentIntensity = ibl.intensity ?? 1;
    this.#scene.environmentRotation.set(0, ibl.rotationY ?? 0, 0);

    this.#iblIsEstimated = ibl.kind === "estimated";
    if (ibl.kind === "estimated") {
      // The texture belongs to whoever built it - the app's `reflection` hook -
      // so it is assigned here, never disposed here, and refreshed in `update`.
      this.#releaseIbl();
      if (this.#estimated === null) {
        this.#report({
          feature: "lightEstimation",
          state: "pending",
          detail: "waiting for a reflection cube map to use as the environment map",
        });
        return;
      }
      this.#scene.environment = this.#estimated;
      return;
    }

    if (ibl.kind === "texture") {
      this.#releaseIbl();
      const token = this.#iblToken;
      void this.#loadEquirect(ibl.src).then((texture) => {
        if (texture === null) return;
        if (token !== this.#iblToken) {
          texture.dispose();
          return;
        }
        this.#iblImage = texture;
        this.#scene.environment = texture;
      });
      return;
    }

    if (ibl.kind === "room" && this.#prefilter !== null) {
      this.#releaseIbl();
      const room = new RoomEnvironment();
      this.#iblImage = this.#prefilter(room);
      room.dispose();
      this.#scene.environment = this.#iblImage;
      return;
    }

    const gradient = ibl.kind === "room" ? NEUTRAL_ROOM : ibl;
    if (this.#iblImage !== null) this.#releaseIbl();
    if (this.#iblTexture === null) {
      this.#iblTexture = createSkyTexture(gradient, this.#skyResolution);
    } else {
      const refreshed = createSkyTexture(gradient, this.#skyResolution);
      this.#iblTexture.image.data = refreshed.image.data;
      this.#iblTexture.needsUpdate = true;
      refreshed.dispose();
    }
    this.#scene.environment = this.#iblTexture;
  }

  observe(host: EnvironmentPortHost): () => void {
    this.#host = host;
    return () => {
      this.#host = null;
    };
  }

  /**
   * Real-world depth occlusion, through three.js's own depth sensing.
   *
   * three.js has done this since r158: when the session grants gpu-optimized
   * depth, WebXRManager reads the depth texture each frame and WebGLRenderer
   * draws a full-screen occlusion mesh before everything else. There is
   * nothing left for this port to render, so its whole job is to decide
   * whether the request can be served and to say so out loud.
   *
   * Everything it refuses, it refuses with a reason. Depth that is silently
   * absent looks exactly like depth that is working on a scene with nothing in
   * front of the user, which is why the reports exist at all.
   */
  applyOcclusion(spec: OcclusionSpec | null): void {
    this.#occlusion = spec;
    this.#occlusionActive = false;
    if (spec === null) {
      this.#report({ feature: "occlusion", state: "unavailable", detail: "occlusion is off" });
      return;
    }
    if (this.#renderer === null) {
      this.#report({
        feature: "occlusion",
        state: "unsupported",
        detail: "this port was constructed without a renderer",
      });
      return;
    }
    const session = this.#renderer.xr.getSession();
    if (session === null || session === undefined) {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail: "no XR session is running",
      });
      return;
    }
    if (!(session.enabledFeatures ?? []).includes("depth-sensing")) {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail: "the session did not enable depth-sensing; ask for it when the session is created",
      });
      return;
    }
    if (session.depthUsage !== "gpu-optimized") {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail:
          "three.js occludes only from a gpu-optimized depth texture; this session gave " +
          (session.depthUsage ?? "none"),
      });
      return;
    }
    if (spec.scope === "tagged") {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail:
          "three.js occludes everything that depth-tests; it cannot be limited to tagged content",
      });
      return;
    }
    this.#report({
      feature: "occlusion",
      state: "pending",
      detail: "waiting for the first depth frame",
    });
  }

  /**
   * Light estimation, straight from WebXR rather than through
   * XREstimatedLight.
   *
   * The probe is requested here and read in update, and each reading becomes
   * plain specs the director lays over the ambient, key and ibl slots. Doing
   * it this way means an app can read the estimate, blend it, or ignore it -
   * none of which is possible when the estimate is two lights in a Group that
   * only the renderer can see.
   */
  applyLightEstimation(estimation: ResolvedLightEstimation | null): void {
    this.#probeToken += 1;
    this.#estimation = estimation;
    this.#probe = null;
    this.#estimating = false;
    if (estimation === null) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail: "light estimation is off",
      });
      return;
    }
    if (this.#renderer === null) {
      this.#report({
        feature: "lightEstimation",
        state: "unsupported",
        detail: "this port was constructed without a renderer",
      });
      return;
    }
    const session = this.#renderer.xr.getSession();
    if (session === null || session === undefined) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail: "no XR session is running",
      });
      return;
    }
    const requestLightProbe = session.requestLightProbe;
    if (typeof requestLightProbe !== "function") {
      this.#report({
        feature: "lightEstimation",
        state: "unsupported",
        detail: "this runtime has no light probe",
      });
      return;
    }
    if (!(session.enabledFeatures ?? []).includes("light-estimation")) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail:
          "the session did not enable light-estimation; ask for it when the session is created",
      });
      return;
    }
    const token = this.#probeToken;
    const format = session.preferredReflectionFormat;
    void requestLightProbe
      .call(session, format === undefined ? undefined : { reflectionFormat: format })
      .then(
        (probe) => {
          if (token !== this.#probeToken) return;
          this.#probe = probe;
          this.#report({
            feature: "lightEstimation",
            state: "pending",
            detail: "waiting for the first estimate",
          });
        },
        (error: unknown) => {
          if (token !== this.#probeToken) return;
          this.#report({
            feature: "lightEstimation",
            state: "unavailable",
            detail: "the runtime refused a light probe: " + String(error),
          });
        },
      );
  }

  /**
   * Poll the two things the host will not push.
   *
   * Called by the director's own update, so an app that already ticks the
   * director gets this for free, and one that does not gets a scene that never
   * occludes - which the reports will say.
   */
  update(): void {
    this.#pollOcclusion();
    this.#pollEstimate();
  }

  dispose(): void {
    this.applySky(null);
    this.applyFog(null);
    this.applyAmbient(null);
    this.applyKeyLight(null);
    this.applyIbl(null);
    this.#host = null;
    this.#probe = null;
    this.#estimation = null;
    this.#estimated = null;
    this.#iblIsEstimated = false;
    this.#parent.remove(this.#group);
    // Nothing is left in the group by the calls above, but a caller that
    // parented something here of its own would otherwise leak silently.
    this.#group.clear();
  }

  #pollOcclusion(): void {
    if (this.#occlusion === null || this.#renderer === null) return;
    if (this.#occlusion.scope === "tagged") return;
    const active = this.#renderer.xr.hasDepthSensing?.() === true;
    if (active === this.#occlusionActive) return;
    this.#occlusionActive = active;
    this.#report(
      active
        ? { feature: "occlusion", state: "active" }
        : { feature: "occlusion", state: "pending", detail: "the depth texture went away" },
    );
    this.#report(
      active
        ? { feature: "depthTexture", state: "active" }
        : { feature: "depthTexture", state: "unavailable" },
    );
  }

  #pollEstimate(): void {
    const estimation = this.#estimation;
    const probe = this.#probe;
    if (estimation === null || probe === null || this.#renderer === null) return;
    const frame = this.#renderer.xr.getFrame?.();
    const estimate = frame?.getLightEstimate?.(probe);
    if (estimate === null || estimate === undefined) return;
    const lighting = toEstimatedLighting(estimate);
    // Shadows are the app's decision, not a measurement, so the flag is
    // stamped onto the measured key light rather than coming from the runtime.
    const key = lighting.key;
    const withShadows =
      estimation.shadows && key !== undefined && key !== null
        ? { ...lighting, key: { ...key, castShadow: true } }
        : lighting;

    // The reflections, when the app gave us a way to reach them. The runtime
    // replaces the texture as the room changes, so it is re-read every poll
    // and swapped in place: the SPEC never changes, only what it points at,
    // which is why this does not go back through the director.
    if (estimation.ibl && this.#reflection !== null) {
      const measured = this.#reflection(probe);
      if (measured !== null && measured !== this.#estimated) {
        this.#estimated = measured;
        if (this.#iblIsEstimated) this.#scene.environment = measured;
      }
    }
    const complete: EstimatedLighting =
      estimation.ibl && this.#estimated !== null
        ? { ...withShadows, ibl: { kind: "estimated" } }
        : withShadows;
    this.#host?.estimate(complete);

    if (estimation.ibl && this.#estimated === null && !this.#saidNoReflection) {
      this.#saidNoReflection = true;
      // This IS the "estimation is running" announcement, with the gap named
      // in it. Letting the plain one fire as well would report active twice
      // with two different details, which is noise dressed as information.
      this.#estimating = true;
      this.#report({
        feature: "lightEstimation",
        state: "active",
        detail:
          "ambient and key are measured; the reflections are not, because no reflection option was given",
      });
      return;
    }
    if (this.#estimating) return;
    this.#estimating = true;
    this.#report({ feature: "lightEstimation", state: "active" });
  }

  #report(report: SensingReport): void {
    this.#host?.report(report);
  }

  /** Load an image and set it up as an equirectangular map. Null on failure. */
  async #loadEquirect(src: string): Promise<Texture | null> {
    try {
      const texture = await this.#textureLoader.loadAsync(src);
      texture.mapping = EquirectangularReflectionMapping;
      texture.colorSpace = SRGBColorSpace;
      return texture;
    } catch {
      // A missing image is the app's problem to fix and not a reason to take
      // the whole environment down; the slot stays as it was.
      return null;
    }
  }

  #releaseSkyTexture(): void {
    if (this.#skyTexture !== null) {
      if (this.#scene.background === this.#skyTexture) this.#scene.background = null;
      this.#skyTexture.dispose();
      this.#skyTexture = null;
    }
    if (this.#skyImage !== null) {
      if (this.#scene.background === this.#skyImage) this.#scene.background = null;
      this.#skyImage.dispose();
      this.#skyImage = null;
    }
  }

  #releaseIbl(): void {
    if (this.#iblTexture !== null) {
      if (this.#scene.environment === this.#iblTexture) this.#scene.environment = null;
      this.#iblTexture.dispose();
      this.#iblTexture = null;
    }
    if (this.#iblImage !== null) {
      if (this.#scene.environment === this.#iblImage) this.#scene.environment = null;
      this.#iblImage.dispose();
      this.#iblImage = null;
    }
  }
}
