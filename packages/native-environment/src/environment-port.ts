/**
 * `EnvironmentPort` for a native host: a Hermes-embedding app that owns
 * rendering itself, over OpenXR or CompositorServices.
 *
 * ---------------------------------------------------------------------------
 * A TRANSLATOR, NOT A DECISION MAKER - MORE LITERALLY HERE THAN ANYWHERE ELSE
 * ---------------------------------------------------------------------------
 * Every other port in this estate at least converts units, builds an object or
 * polls something. This one does none of that: the director has already
 * resolved the interpolation, the mix and which slot actually changed, and a
 * `SkySpec` or an `AudioCue`'s `src` is already plain data the native side
 * resolves and decodes with its own loaders. So `applySky` through `applyIbl`
 * are one line each, and the two sensor-backed members exist on this port at
 * all ONLY when the host implements them.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPTIONAL MEMBERS ARE SOMETIMES ABSENT, NOT SOMETIMES REPORTING
 * ---------------------------------------------------------------------------
 * `EnvironmentDirector.setOcclusion` and `setLightEstimation` already check
 * `this.#port.applyOcclusion === undefined` / `applyLightEstimation ===
 * undefined` and report `unsupported` themselves the moment an app asks for
 * one the port cannot do - see `EnvironmentPort.applyOcclusion`'s own comment:
 * "Report through observe rather than throwing". Wiring a method here that
 * only re-reports what the director already knows would be the same sentence
 * twice, so instead this port simply does not GROW the method when the host
 * lacks it, and the director's own check does the reporting - the absence is
 * still what makes it visible, only the line that says so lives once.
 */
import type { EnvironmentPort, EnvironmentPortHost } from "@realitycollective/webxr-environment";
import type {
  AmbientLightSpec,
  FogSpec,
  IblSpec,
  KeyLightSpec,
  OcclusionSpec,
  ResolvedLightEstimation,
  SkySpec,
} from "@realitycollective/webxr-environment";
import type { NativeEnvironmentHost } from "./native-types.js";
import { getEnvironmentHost } from "./native-types.js";

export class NativeEnvironmentPort implements EnvironmentPort {
  readonly #host: NativeEnvironmentHost;
  #unobserve: (() => void) | undefined;

  constructor(host?: NativeEnvironmentHost) {
    this.#host = getEnvironmentHost(host);
    if (this.#host.applyOcclusion !== undefined) {
      const applyOcclusion = this.#host.applyOcclusion;
      this.applyOcclusion = (spec: OcclusionSpec | null) => applyOcclusion(spec);
    }
    if (this.#host.applyLightEstimation !== undefined) {
      const applyLightEstimation = this.#host.applyLightEstimation;
      this.applyLightEstimation = (estimation: ResolvedLightEstimation | null) =>
        applyLightEstimation(estimation);
    }
  }

  applySky(sky: SkySpec | null): void {
    this.#host.applySky(sky);
  }

  applyFog(fog: FogSpec | null): void {
    this.#host.applyFog(fog);
  }

  applyAmbient(light: AmbientLightSpec | null): void {
    this.#host.applyAmbient(light);
  }

  applyKeyLight(light: KeyLightSpec | null): void {
    this.#host.applyKeyLight(light);
  }

  applyIbl(ibl: IblSpec | null): void {
    this.#host.applyIbl(ibl);
  }

  /** Present only when the host implements `applyOcclusion`. See the file comment. */
  applyOcclusion?: (spec: OcclusionSpec | null) => void;

  /** Present only when the host implements `applyLightEstimation`. See the file comment. */
  applyLightEstimation?: (estimation: ResolvedLightEstimation | null) => void;

  /**
   * Wire the host's two report channels to the director's inbound seam.
   *
   * Both are optional on the host, and independently so: a host can measure
   * light without ever reporting occlusion, or the reverse. Whichever are
   * missing simply never fire, which is silence rather than a lie - see
   * `sensing.ts` for why a report and an estimate are the only two things that
   * are allowed to travel this way.
   */
  observe(host: EnvironmentPortHost): () => void {
    const unsubscribers: Array<() => void> = [];
    if (this.#host.onSensingReport !== undefined) {
      unsubscribers.push(this.#host.onSensingReport((report) => host.report(report)));
    }
    if (this.#host.onLightEstimate !== undefined) {
      unsubscribers.push(this.#host.onLightEstimate((estimate) => host.estimate(estimate)));
    }
    const stop = () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
    this.#unobserve = stop;
    return stop;
  }

  dispose(): void {
    this.#unobserve?.();
    this.#unobserve = undefined;
  }
}
