/**
 * Turning one `XRLightEstimate` into the specs this stack already speaks.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PURE FUNCTION AND NOT A THREE.JS OBJECT
 * ---------------------------------------------------------------------------
 * three.js ships `XREstimatedLight`, which does the same arithmetic and hands
 * back a `LightProbe` and a `DirectionalLight` already in a `Group`. Using it
 * would mean this port owned two lights the director does not know about,
 * sitting beside the two it does, with no way for an app to read the estimate
 * or to blend it with what it asked for.
 *
 * So the maths is done here instead, into plain data, and the ordinary ambient
 * and key path applies it. The app can print it, log it, or ignore it. The
 * conversions below match `XREstimatedLight`'s, deliberately, so switching
 * between the two produces the same scene.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * The reflection cube map. `XRWebGLBinding.getReflectionCubeMap` needs a live
 * GL context and produces a texture that must then be prefiltered, which is
 * a renderer's job and not this function's. The port reports that the `ibl`
 * part of an estimate was not measured rather than inventing one.
 */
import type {
  AmbientLightSpec,
  EstimatedLighting,
  KeyLightSpec,
  Rgb,
} from "@realitycollective/webxr-environment";
import type { XrLightEstimateLike } from "./xr.js";

/**
 * The L0 band of a spherical-harmonic probe, scaled to irradiance.
 *
 * `0.886227` is `Y00 * PI` - the constant that turns the DC coefficient of a
 * real-valued SH basis into the average light arriving from every direction,
 * which is exactly what an ambient light is.
 */
export const SH_DC_TO_IRRADIANCE = 0.886227;

/** Split a linear RGB triple into a hue and a scalar an engine can scale. */
function splitColour(r: number, g: number, b: number): { colour: Rgb; intensity: number } {
  const peak = Math.max(r, g, b);
  if (!(peak > 0)) return { colour: [0, 0, 0], intensity: 0 };
  return { colour: [r / peak, g / peak, b / peak], intensity: peak };
}

/**
 * The ambient term of an estimate, or `null` when the runtime sent no probe.
 *
 * Only the first three floats are read. The higher bands describe which
 * direction the light comes FROM, and an ambient light has no direction to
 * put them on; the key light below carries that information instead.
 */
export function ambientFromSphericalHarmonics(
  coefficients: ArrayLike<number> | undefined,
): AmbientLightSpec | null {
  if (coefficients === undefined || coefficients.length < 3) return null;
  const { colour, intensity } = splitColour(
    (coefficients[0] ?? 0) * SH_DC_TO_IRRADIANCE,
    (coefficients[1] ?? 0) * SH_DC_TO_IRRADIANCE,
    (coefficients[2] ?? 0) * SH_DC_TO_IRRADIANCE,
  );
  return { colour, intensity };
}

/**
 * The primary light of an estimate, or `null` when there is not one.
 *
 * WebXR's `primaryLightDirection` points TOWARD the light. `KeyLightSpec`
 * names the direction light TRAVELS, so it is negated here - the same
 * inversion the three.js port already does when it positions a directional
 * light, applied once at the source instead of twice by accident.
 */
export function keyFromEstimate(estimate: XrLightEstimateLike): KeyLightSpec | null {
  const direction = estimate.primaryLightDirection;
  const power = estimate.primaryLightIntensity;
  if (direction === undefined || power === undefined) return null;
  const { colour, intensity } = splitColour(power.x, power.y, power.z);
  return {
    colour,
    // Matches `XREstimatedLight`: an estimate dimmer than unity keeps unity as
    // its scalar so the colour stays a colour rather than becoming a dimmer.
    intensity: Math.max(1, intensity),
    direction: [-direction.x, -direction.y, -direction.z],
  };
}

/**
 * One estimate, as the slots it is allowed to take over.
 *
 * A member is present only when the runtime actually measured it, which is the
 * difference the director needs: an omitted slot keeps whatever the app asked
 * for, and an explicit `null` means the room really is that dark.
 */
export function toEstimatedLighting(estimate: XrLightEstimateLike): EstimatedLighting {
  const ambient = ambientFromSphericalHarmonics(estimate.sphericalHarmonicsCoefficients);
  const key = keyFromEstimate(estimate);
  return {
    ...(ambient === null ? {} : { ambient }),
    ...(key === null ? {} : { key }),
  };
}
