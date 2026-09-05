import { describe, expect, it } from "vitest";
import { deepEquals } from "@realitycollective/webxr-environment";

describe("deepEquals", () => {
  it("compares primitives and identity", () => {
    expect(deepEquals(1, 1)).toBe(true);
    expect(deepEquals("a", "b")).toBe(false);
    expect(deepEquals(null, null)).toBe(true);
    expect(deepEquals(null, {})).toBe(false);
    expect(deepEquals({}, null)).toBe(false);
    expect(deepEquals(1, "1")).toBe(false);
  });

  it("compares arrays element-wise", () => {
    expect(deepEquals([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(deepEquals([1, 2], [1, 2, 3])).toBe(false);
    expect(deepEquals([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(deepEquals({ 0: 1 }, [1])).toBe(false);
  });

  it("compares objects key-wise, in either direction", () => {
    expect(deepEquals({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe(true);
    expect(deepEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEquals({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("treats an explicit undefined and an absent key as the same", () => {
    // `{ horizon: undefined }` and `{}` describe the same sky, and a director
    // that pushed the slot again for that difference would repaint the world
    // for nothing.
    expect(deepEquals({ horizon: undefined }, {})).toBe(true);
  });
});
