/**
 * `EnvironmentPort` for Google XR Blocks.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE THREE.JS PORT PLUS TWO SENSORS
 * ---------------------------------------------------------------------------
 * XR Blocks renders through three.js, so the sky, the fog, the two lights and
 * the environment map are already solved by the three.js adapter in this same
 * repository, and this class extends it rather than reimplementing four slots
 * that would then drift. That is the same composition `xrblocks-interactions`
 * makes over `threejs-interactions`: inside one repository adapters build on
 * each other, and it is only BETWEEN families that nothing may reference
 * anything.
 *
 * What XR Blocks adds is the sensing. Its `Depth` manager owns the occlusion
 * pass, its `Lighting` manager owns WebXR light estimation, and both are
 * configured at init - so this port turns them on and off, reads them, and is
 * honest about the settings it arrived too late to change.
 *
 * ---------------------------------------------------------------------------
 * WHO OWNS THE ESTIMATED LIGHTS
 * ---------------------------------------------------------------------------
 * XR Blocks can put its own estimated lights in the scene (`useAmbientSH`,
 * `useDirectionalLight`). If it does, and this package applies the same
 * estimate to the ambient and key slots, the room is lit twice. So the report
 * this port sends says which one is on, and an app that wants the estimate as
 * DATA - blended, clamped, or ignored - turns the XR Blocks lights off and
 * lets the director own them.
 */
import type { Scene } from "three";
import {
  ThreeEnvironmentPort,
  type ThreeEnvironmentPortOptions,
} from "@realitycollective/threejs-environment";
import { ambientFromSphericalHarmonics } from "@realitycollective/threejs-environment";
import type {
  EnvironmentPortHost,
  EstimatedLighting,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  SensingReport,
} from "@realitycollective/webxr-environment";
import type { XBLightingLike, XRBlocksEnvironmentContext } from "./xrblocks.js";

/**
 * One reading of the XR Blocks lighting manager, as environment specs.
 *
 * Pure and exported, because this is where the arithmetic lives and a function
 * is easier to check than a manager. `ambientLight` is the probe's DC band, so
 * it converts exactly as a WebXR estimate does; the directional light points
 * AT the light, so the key light's direction is its negation.
 */
export function estimatedFromLighting(lighting: XBLightingLike): EstimatedLighting {
  const ambient = ambientFromSphericalHarmonics(
    lighting.ambientLight === undefined
      ? undefined
      : [lighting.ambientLight.x, lighting.ambientLight.y, lighting.ambientLight.z],
  );
  const light = lighting.dirLight;
  const key: KeyLightSpec | null =
    light === undefined
      ? null
      : {
          colour: [light.color.r, light.color.g, light.color.b],
          intensity: light.intensity,
          direction: [-light.position.x, -light.position.y, -light.position.z],
        };
  return {
    ...(ambient === null ? {} : { ambient }),
    ...(key === null ? {} : { key }),
  };
}

export class XRBlocksEnvironmentPort extends ThreeEnvironmentPort {
  readonly #context: XRBlocksEnvironmentContext;
  #host: EnvironmentPortHost | null = null;
  #occlusion: OcclusionSpec | null = null;
  #occluding = false;
  #estimation: ResolvedLightEstimation | null = null;
  #estimating = false;

  constructor(
    scene: Scene,
    context: XRBlocksEnvironmentContext,
    options: ThreeEnvironmentPortOptions = {},
  ) {
    super(scene, options);
    this.#context = context;
  }

  override observe(host: EnvironmentPortHost): () => void {
    this.#host = host;
    const stopBase = super.observe(host);
    return () => {
      this.#host = null;
      stopBase();
    };
  }

  /**
   * Occlusion, through the XR Blocks depth manager.
   *
   * XR Blocks builds its occlusion pass during init, so this can start and
   * stop depth and choose how the depth texture is blurred, and it cannot
   * conjure an occlusion pass that was never built. When it was not, the
   * report says exactly which option to set.
   */
  override applyOcclusion(spec: OcclusionSpec | null): void {
    this.#occlusion = spec;
    const depth = this.#context.depth;

    if (spec === null) {
      if (this.#occluding) depth?.pauseDepth?.(this);
      this.#occluding = false;
      if (depth?.options?.occlusion !== undefined) depth.options.occlusion.enabled = false;
      this.#report({ feature: "occlusion", state: "unavailable", detail: "occlusion is off" });
      return;
    }
    if (depth === undefined) {
      this.#report({
        feature: "occlusion",
        state: "unsupported",
        detail: "this port was constructed without an XR Blocks depth manager",
      });
      return;
    }
    if (depth.options?.enabled !== true) {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail: "XR Blocks depth is not enabled; set depth.enabled in its options before init",
      });
      return;
    }
    if (depth.options.occlusion === undefined) {
      this.#report({
        feature: "occlusion",
        state: "unavailable",
        detail:
          "XR Blocks built no occlusion pass; set depth.occlusion.enabled in its options before init",
      });
      return;
    }

    // Soft and minmax-soft both blur; XR Blocks has one blur, so minmax-soft
    // is the same picture here and the report says so rather than pretending
    // an edge-aware mode exists.
    const blurred = spec.mode !== "hard";
    depth.options.occlusion.enabled = true;
    if (depth.options.depthTexture !== undefined) {
      depth.options.depthTexture.applyGaussianBlur = blurred;
      depth.options.depthTexture.constantKernel = blurred && (spec.softness ?? 0) >= 0.5;
    }
    depth.resumeDepth?.(this);
    this.#occluding = true;

    const ignored = describeIgnored(spec, depth.options);
    this.#report({
      feature: "occlusion",
      state: "pending",
      detail:
        ignored === null
          ? "waiting for the first depth frame"
          : "waiting for the first depth frame; " + ignored,
    });
  }

  /**
   * Light estimation, read out of the XR Blocks lighting manager.
   *
   * XR Blocks does the WebXR half itself - it owns the `XREstimatedLight` and
   * updates its own directional light and probe every frame. This port reads
   * that and turns it into specs, so the estimate lands in the same document
   * everything else in this package goes through.
   */
  override applyLightEstimation(estimation: ResolvedLightEstimation | null): void {
    this.#estimation = estimation;
    this.#estimating = false;
    const lighting = this.#context.lighting;

    if (estimation === null) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail: "light estimation is off",
      });
      return;
    }
    if (lighting === undefined) {
      this.#report({
        feature: "lightEstimation",
        state: "unsupported",
        detail: "this port was constructed without an XR Blocks lighting manager",
      });
      return;
    }
    if (lighting.options?.enabled !== true) {
      this.#report({
        feature: "lightEstimation",
        state: "unavailable",
        detail: "XR Blocks lighting is not enabled; set lighting.enabled in its options before init",
      });
      return;
    }
    this.#report({
      feature: "lightEstimation",
      state: "pending",
      detail: "waiting for the first estimate",
    });
  }

  /** Poll both managers. Called by the director's `update`. */
  override update(): void {
    this.#pollOcclusion();
    this.#pollEstimate();
  }

  override dispose(): void {
    if (this.#occluding) this.#context.depth?.pauseDepth?.(this);
    this.#occluding = false;
    this.#estimation = null;
    this.#host = null;
    super.dispose();
  }

  #pollOcclusion(): void {
    if (this.#occlusion === null || !this.#occluding) return;
    const active = this.#context.depth?.getTexture?.(0) !== undefined;
    if (active === (this.getSensingState("occlusion") === "active")) return;
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
    const lighting = this.#context.lighting;
    if (estimation === null || lighting === undefined) return;
    if (lighting.dirLight === undefined && lighting.ambientLight === undefined) return;

    const measured = estimatedFromLighting(lighting);
    const key = measured.key;
    this.#host?.estimate(
      estimation.shadows && key !== undefined && key !== null
        ? { ...measured, key: { ...key, castShadow: true } }
        : measured,
    );
    if (this.#estimating) return;
    this.#estimating = true;
    const doubled =
      lighting.options?.useAmbientSH === true || lighting.options?.useDirectionalLight === true;
    this.#report({
      feature: "lightEstimation",
      state: "active",
      ...(doubled
        ? {
            detail:
              "XR Blocks is also lighting the scene itself; turn off useAmbientSH and useDirectionalLight to avoid lighting the room twice",
          }
        : {}),
    });
  }

  /**
   * What this port last said about a feature.
   *
   * The base class keeps no such record and the director is not readable from
   * here, so occlusion state is tracked locally rather than inferred from a
   * flag that would go stale the moment the app changed its mind.
   */
  #states = new Map<string, string>();

  getSensingState(feature: string): string | undefined {
    return this.#states.get(feature);
  }

  #report(report: SensingReport): void {
    this.#states.set(report.feature, report.state);
    this.#host?.report(report);
  }
}

/** The parts of a spec XR Blocks was configured for before we could ask. */
function describeIgnored(
  spec: OcclusionSpec,
  options: NonNullable<XRBlocksEnvironmentContext["depth"]>["options"],
): string | null {
  const ignored: string[] = [];
  if (spec.mode === "minmax-soft") ignored.push("minmax-soft is drawn as soft here");
  if (spec.scope === "tagged") ignored.push("XR Blocks occludes everything that depth-tests");
  const usage = spec.source?.usage;
  if (usage !== undefined && options?.usagePreference !== undefined) {
    if (!options.usagePreference.includes(usage)) {
      ignored.push("the session was requested with " + options.usagePreference.join(", "));
    }
  }
  if (spec.updateFps !== undefined) ignored.push("updateFps applies to the depth mesh, not the pass");
  return ignored.length === 0 ? null : ignored.join("; ");
}
