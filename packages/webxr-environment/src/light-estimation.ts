/**
 * Lighting the room, measured by the headset rather than described by the app.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THREE BOOLEANS AND NOT A NEW DOCUMENT
 * ---------------------------------------------------------------------------
 * WebXR's `light-estimation` produces exactly three things, and two shipped
 * implementations agree on all three: a spherical-harmonic probe, a primary
 * directional light with a colour and an intensity, and a reflection cube map.
 * three.js's `XREstimatedLight` builds precisely those, and XR Blocks' own
 * lighting module consumes that class and exposes which of the three to use
 * (`useAmbientSH`, `useDirectionalLight`, `castDirectionalLightShadow`).
 *
 * Those three map one for one onto slots this package already owns: ambient,
 * key and ibl. So there is no new document here and no new shape crossing the
 * seam - only a choice of WHICH slots the measurement is allowed to take over,
 * and the measurement itself arrives as the same specs the app writes by hand.
 *
 * ---------------------------------------------------------------------------
 * IT IS A LAYER, NOT A REPLACEMENT
 * ---------------------------------------------------------------------------
 * This works the way passthrough works, and for the same reason. The app keeps
 * describing the environment it wants; while estimation is on and measuring,
 * the estimate is laid over the top of the slots it was given; when it stops,
 * what the app asked for comes back unchanged. Nothing has to remember what to
 * restore, and an app can leave estimation on permanently without its own
 * lighting becoming unreachable.
 */

/**
 * Which slots a live estimate may take over.
 *
 * All three light slots default to on, because an app that asks for light
 * estimation is asking for the room's light and not for a third of it.
 * `shadows` defaults to off: it costs a shadow map and a second render, and it
 * is a rendering decision the app should make on purpose.
 */
export interface LightEstimationSpec {
  readonly ambient?: boolean;
  readonly key?: boolean;
  readonly ibl?: boolean;
  /** Ask the host to cast shadows from the estimated key light. */
  readonly shadows?: boolean;
}

export const DEFAULT_LIGHT_ESTIMATION: LightEstimationSpec = Object.freeze({
  ambient: true,
  key: true,
  ibl: true,
  shadows: false,
});

/** `spec` with every default filled in, which is what a port receives. */
export interface ResolvedLightEstimation {
  readonly ambient: boolean;
  readonly key: boolean;
  readonly ibl: boolean;
  readonly shadows: boolean;
}

export function resolveLightEstimation(spec: LightEstimationSpec): ResolvedLightEstimation {
  return {
    ambient: spec.ambient ?? true,
    key: spec.key ?? true,
    ibl: spec.ibl ?? true,
    shadows: spec.shadows ?? false,
  };
}
