/**
 * The tour's parts as NAMED SCENE-ASSETS for the native host: simple three.js
 * meshes, cooked to glTF by the conversion pipeline (`rc assets`), one asset
 * per part and placed by the documents in `scenes/`. Only the cook runs this
 * module; the harness bundle never imports three.js.
 *
 * Each asset is the part's own mesh at the origin: position lives in the
 * scene document, as the pipeline expects. The beacon has no document node.
 * The tour spawns it by name with `SceneManager.instantiate`.
 */
import { AssetType, defineAssets } from "@iwsdk/core";
import { BoxGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, OctahedronGeometry, SphereGeometry, TorusGeometry, type BufferGeometry, type Object3D } from "three";
import { TOUR_PARTS, type TourShape } from "./src/tour-layout.js";

void AssetType;

function geometryOf(shape: TourShape): BufferGeometry {
  switch (shape.kind) {
    case "box":
      return new BoxGeometry(shape.size[0], shape.size[1], shape.size[2]);
    case "sphere":
      return new SphereGeometry(shape.radius, 24, 16);
    case "cylinder":
      return new CylinderGeometry(shape.radius, shape.radius, shape.height, 24);
    case "torus":
      return new TorusGeometry(shape.radius, shape.tube, 12, 32);
    case "octahedron":
      return new OctahedronGeometry(shape.radius);
  }
}

const assets: Record<string, Object3D> = {};
for (const part of TOUR_PARTS) {
  const mesh = new Mesh(geometryOf(part.shape), new MeshStandardMaterial({ color: part.colour, roughness: 0.6, metalness: 0.1 }));
  mesh.name = part.name;
  assets[part.name] = mesh;
}

// IWSDK's typings widen three.js's Object3D with pointer-capture members the cook never reads.
export default defineAssets(assets as never);
