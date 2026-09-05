/**
 * Interpolation between two resolved environments.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE WORTH KNOWING
 * ---------------------------------------------------------------------------
 * A slot interpolates only when both ends describe the SAME KIND of thing: two
 * gradient skies, two linear fogs, two ambient lights. Anything else - a slot
 * appearing, a slot disappearing, a linear fog becoming exponential - takes
 * the TARGET value immediately, at t=0, and holds it for the rest of the
 * transition.
 *
 * That is a deliberate choice over pretending. There is no honest halfway
 * point between "fog" and "no fog", and a cross-fade between a gradient dome
 * and a flat colour would need a compositing pass this package does not own.
 * Snapping is predictable, costs nothing, and is easy to work around: an app
 * that wants fog to ease in defines its "clear" state as fog pushed out to the
 * far plane rather than as `null`, and then both ends are linear fogs and the
 * transition interpolates properly. The README says this too, next to a worked
 * example, because it is the first thing anyone trips over.
 */
import type {
  AmbientLightSpec,
  FogExponential,
  FogLinear,
  FogSpec,
  KeyLightSpec,
  ResolvedEnvironment,
  SkyGradient,
  SkySolid,
  SkySpec,
  Vec3,
} from "./environment.js";
import { lerp, lerpRgb } from "./math.js";

function lerpVec3(from: Vec3, to: Vec3, t: number): Vec3 {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

function lerpSky(from: SkySpec | null, to: SkySpec | null, t: number): SkySpec | null {
  if (from === null || to === null || from.kind !== to.kind) return to;
  // The kinds are equal by the guard above, but TypeScript cannot carry that
  // between two variables, so `from` is asserted rather than re-tested. The
  // alternative is a second pair of branches that no input can ever reach.
  if (to.kind === "solid") {
    return { kind: "solid", colour: lerpRgb((from as SkySolid).colour, to.colour, t) };
  }
  const gradient = from as SkyGradient;
  return {
    kind: "gradient",
    top: lerpRgb(gradient.top, to.top, t),
    bottom: lerpRgb(gradient.bottom, to.bottom, t),
    horizon: lerp(gradient.horizon ?? 0.5, to.horizon ?? 0.5, t),
    exponent: lerp(gradient.exponent ?? 1, to.exponent ?? 1, t),
  };
}

function lerpFog(from: FogSpec | null, to: FogSpec | null, t: number): FogSpec | null {
  if (from === null || to === null || from.kind !== to.kind) return to;
  // Same narrowing limitation as `lerpSky` above, handled the same way.
  if (to.kind === "linear") {
    const linear = from as FogLinear;
    return {
      kind: "linear",
      colour: lerpRgb(linear.colour, to.colour, t),
      near: lerp(linear.near, to.near, t),
      far: lerp(linear.far, to.far, t),
    };
  }
  const exponential = from as FogExponential;
  return {
    kind: "exponential",
    colour: lerpRgb(exponential.colour, to.colour, t),
    density: lerp(exponential.density, to.density, t),
  };
}

function lerpAmbient(
  from: AmbientLightSpec | null,
  to: AmbientLightSpec | null,
  t: number,
): AmbientLightSpec | null {
  if (from === null || to === null) return to;
  return {
    colour: lerpRgb(from.colour, to.colour, t),
    intensity: lerp(from.intensity, to.intensity, t),
  };
}

function lerpKey(
  from: KeyLightSpec | null,
  to: KeyLightSpec | null,
  t: number,
): KeyLightSpec | null {
  if (from === null || to === null) return to;
  // `castShadow` is a mode, not a quantity: it takes the target's value at
  // once rather than flickering at some arbitrary midpoint.
  const base = {
    colour: lerpRgb(from.colour, to.colour, t),
    intensity: lerp(from.intensity, to.intensity, t),
    direction: lerpVec3(from.direction, to.direction, t),
  };
  return to.castShadow === undefined ? base : { ...base, castShadow: to.castShadow };
}

/**
 * Blend two resolved environments. `t` is the EASED progress in 0..1; the
 * director has already applied the curve, so this stays linear per channel.
 */
export function interpolateEnvironment(
  from: ResolvedEnvironment,
  to: ResolvedEnvironment,
  t: number,
): ResolvedEnvironment {
  if (t <= 0) {
    // At the very start every non-interpolable slot has already switched, so
    // this is `from` with the snapping applied - not `from` itself.
    return {
      sky: lerpSky(from.sky, to.sky, 0),
      fog: lerpFog(from.fog, to.fog, 0),
      ambient: lerpAmbient(from.ambient, to.ambient, 0),
      key: lerpKey(from.key, to.key, 0),
    };
  }
  if (t >= 1) return to;
  return {
    sky: lerpSky(from.sky, to.sky, t),
    fog: lerpFog(from.fog, to.fog, t),
    ambient: lerpAmbient(from.ambient, to.ambient, t),
    key: lerpKey(from.key, to.key, t),
  };
}
