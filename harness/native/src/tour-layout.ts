/**
 * The two small scenes the play tour loads, as plain data. `scene-assets.ts`
 * turns each part into a three.js mesh for the cook step, and
 * `scripts/write-scenes.mjs` turns the same list into the scene documents, so
 * the host places exactly the parts the cook produced. No engine is imported
 * here: the harness bundle reads the scene sources and the beacon asset name.
 */
export type TourShape =
  | { readonly kind: "box"; readonly size: readonly [number, number, number] }
  | { readonly kind: "sphere"; readonly radius: number }
  | { readonly kind: "cylinder"; readonly radius: number; readonly height: number }
  | { readonly kind: "torus"; readonly radius: number; readonly tube: number }
  | { readonly kind: "octahedron"; readonly radius: number };

export interface TourPart {
  /** The scene node id and the asset name. Unique across both scenes. */
  readonly name: string;
  readonly shape: TourShape;
  /** 0xRRGGBB. */
  readonly colour: number;
  /** World metres. The floor of the play space is y = 0 and the head starts near y = 1.6. */
  readonly position: readonly [number, number, number];
}

export interface TourScene {
  readonly id: string;
  /** The scene source the host resolves: the pipeline packs `scenes/<file>` under the assets folder. */
  readonly src: string;
  readonly file: string;
  readonly parts: readonly TourPart[];
}

/** Scene A: a low block and a ring, in front of and to the left of the start. */
export const TOUR_SCENE_A: TourScene = {
  id: "tour-a",
  src: "/scenes/tour-a.iwsdk.scene.json",
  file: "tour-a.iwsdk.scene.json",
  parts: [
    { name: "tour-a-block", shape: { kind: "box", size: [0.5, 0.5, 0.5] }, colour: 0xe4572e, position: [-0.8, 0.25, -2] },
    { name: "tour-a-ring", shape: { kind: "torus", radius: 0.3, tube: 0.06 }, colour: 0xf3a712, position: [-0.8, 1.2, -2] },
  ],
};

/** Scene B, loaded on top of A: a pillar and a ball on the right. */
export const TOUR_SCENE_B: TourScene = {
  id: "tour-b",
  src: "/scenes/tour-b.iwsdk.scene.json",
  file: "tour-b.iwsdk.scene.json",
  parts: [
    { name: "tour-b-pillar", shape: { kind: "cylinder", radius: 0.2, height: 1.2 }, colour: 0x29335c, position: [0.8, 0.6, -2] },
    { name: "tour-b-orb", shape: { kind: "sphere", radius: 0.25 }, colour: 0x669bbc, position: [0.8, 1.45, -2] },
  ],
};

/**
 * The persistent node's asset. The tour spawns it once with `instantiate`,
 * makes it persistent, and it stays across every load and unload after.
 */
export const TOUR_BEACON: TourPart = {
  name: "tour-beacon",
  shape: { kind: "octahedron", radius: 0.15 },
  colour: 0x2ec4b6,
  position: [0, 2.2, -2],
};

export const TOUR_SCENES: readonly TourScene[] = [TOUR_SCENE_A, TOUR_SCENE_B];
export const TOUR_PARTS: readonly TourPart[] = [...TOUR_SCENE_A.parts, ...TOUR_SCENE_B.parts, TOUR_BEACON];
