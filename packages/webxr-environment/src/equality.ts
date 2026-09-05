/**
 * Structural equality for the plain-data specs.
 *
 * The director pushes a slot to the port only when that slot actually changed,
 * which needs a comparison that does not care whether two identical specs are
 * the same object. Specs are small, flat, JSON-shaped values - numbers,
 * strings, booleans, number tuples and one level of object - so a compact
 * recursive compare is exactly the right tool and there is no reason to reach
 * for a library.
 *
 * `undefined` and "absent" compare equal on purpose: `{ horizon: undefined }`
 * and `{}` describe the same sky, and under `exactOptionalPropertyTypes` the
 * first is not even constructible from outside.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEquals(a[i], b[i])) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEquals(left[key], right[key])) return false;
  }
  return true;
}
