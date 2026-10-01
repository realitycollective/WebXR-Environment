/**
 * `env/audio-listener` on the web: the listener is the viewer's head. The
 * port parents the listener to the head it is given, so the listener's
 * world pose follows the camera every frame, as IWSDK's AudioSystem does.
 */
import { describe, expect, it } from "vitest";
import { Object3D, PerspectiveCamera, Scene } from "three";
import { createTestListener } from "./helpers.js";
import { AUDIO_LISTENER_RULE } from "@realitycollective/webxr-environment";
import { ThreeAudioPort, createThreeAudio } from "@realitycollective/threejs-environment";
import { createXRBlocksAudio } from "@realitycollective/xrblocks-environment";

function listenerAndCamera() {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  camera.position.set(1, 1.6, -2);
  scene.add(camera);
  const { listener } = createTestListener();
  return { scene, camera, listener };
}

describe("the audio listener rides the head", () => {
  it("is stated by the core as the head", () => {
    expect(AUDIO_LISTENER_RULE).toBe("head");
  });

  it("parents a detached listener to the head it is given, so the listener's world pose follows the camera", () => {
    const { scene, camera, listener } = listenerAndCamera();
    new ThreeAudioPort(listener, { head: camera, parent: scene });
    expect(listener.parent).toBe(camera);
    // Parented at the camera's origin with no offset of its own, the
    // listener's world pose is the camera's every frame: three.js keeps a
    // child on its parent, and AudioListener writes that pose to Web Audio
    // in its own updateMatrixWorld (not run here: the test context has no
    // positional listener nodes).
    expect(listener.position.toArray()).toEqual([0, 0, 0]);
    expect(listener.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    expect(camera.children).toContain(listener);
  });

  it("leaves a listener already under the head where it is, and a listener elsewhere is moved under the head", () => {
    const { scene, camera, listener } = listenerAndCamera();
    const rig = new Object3D();
    rig.add(camera);
    camera.add(listener);
    new ThreeAudioPort(listener, { head: camera, parent: scene });
    expect(listener.parent).toBe(camera);
    const stray = createTestListener().listener;
    scene.add(stray);
    new ThreeAudioPort(stray, { head: camera, parent: scene });
    expect(stray.parent).toBe(camera);
  });

  it("applies through createThreeAudio and createXRBlocksAudio alike", () => {
    const a = listenerAndCamera();
    createThreeAudio(a.listener, { head: a.camera, parent: a.scene });
    expect(a.listener.parent).toBe(a.camera);
    const b = listenerAndCamera();
    createXRBlocksAudio(b.listener, { head: b.camera, parent: b.scene });
    expect(b.listener.parent).toBe(b.camera);
    // Without a head the app's own parenting stands (the documented opt-out).
    const c = listenerAndCamera();
    c.scene.add(c.listener);
    createThreeAudio(c.listener, { parent: c.scene });
    expect(c.listener.parent).toBe(c.scene);
  });
});
