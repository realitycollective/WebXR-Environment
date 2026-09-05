/**
 * Numeric helpers shared by the directors. Everything here is pure, allocation
 * conscious and engine free: colours are plain three-number tuples rather than
 * any engine's colour class, because the whole point of this package is that
 * the same environment description drives three.js, IWSDK or anything else.
 */
import type { Rgb } from "./environment.js";

/** Clamp to the unit interval. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Clamp to an arbitrary range. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Linear interpolation. `t` is NOT clamped - the callers already clamp it. */
export function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Component-wise colour interpolation.
 *
 * Deliberately naive: this mixes in whatever space the caller authored in
 * (sRGB, by convention throughout this package) rather than converting to
 * linear and back. A sky fading from blue to black through a slightly dark
 * blue is what an author authoring in sRGB expects to see, and the conversion
 * would cost an allocation per channel per frame for a difference nobody has
 * asked for. An app that wants a physically correct mix can author its own
 * midpoint preset and transition through it.
 */
export function lerpRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
}

/** True when two colours are identical channel for channel. */
export function rgbEquals(a: Rgb, b: Rgb): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** `0xff8800` -> `[1, 0.533…, 0]`. Convenience for authoring presets. */
export function rgbFromHex(hex: number): Rgb {
  return [((hex >> 16) & 0xff) / 255, ((hex >> 8) & 0xff) / 255, (hex & 0xff) / 255];
}

/** `[1, 0.533…, 0]` -> `0xff8800`. The inverse, for adapters that want a hex. */
export function rgbToHex(rgb: Rgb): number {
  const channel = (value: number) => Math.round(clamp01(value) * 255);
  return (channel(rgb[0]) << 16) | (channel(rgb[1]) << 8) | channel(rgb[2]);
}

/** The named easing curves. A transition may also carry its own function. */
export type EasingName = "linear" | "easeIn" | "easeOut" | "easeInOut";

/** `t` in 0..1 -> eased `t` in 0..1. */
export type EasingFunction = (t: number) => number;

const EASINGS: Readonly<Record<EasingName, EasingFunction>> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
};

/** Resolve an easing name or function to a function. Unknown names are linear. */
export function resolveEasing(easing: EasingName | EasingFunction | undefined): EasingFunction {
  if (typeof easing === "function") return easing;
  if (easing !== undefined && easing in EASINGS) return EASINGS[easing];
  return EASINGS.linear;
}
