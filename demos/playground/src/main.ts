/**
 * The environment playground: standalone three.js + WebXR.
 *
 * It exists to make four things visible that are otherwise only assertions in
 * a test file:
 *
 * 1. **A transition is one call.** Pick a preset and the sky, the fog and both
 *    lights ease together over the same curve, because they are one document
 *    rather than five things that happen to be animated at once.
 * 2. **Passthrough is a suppression, not a state change.** Toggle it and the
 *    sky and fog go; toggle it back and the environment returns EXACTLY where
 *    it was, mid-transition included. Nothing here remembers what to restore.
 * 3. **The mix is the app's.** The bus sliders move voices that are already
 *    sounding, and a caller's requested gain is relative to them, never over
 *    them.
 * 4. **The binding is the app's.** Nothing plays a sound on its own. The
 *    button handler below subscribes a DOM event to `audio.play`, which is the
 *    entire integration surface - swap in an interaction event, a level
 *    change, a socket message, and the line looks the same. Nothing in the
 *    library knows or cares which.
 *
 * 5. **A sensor that does nothing says so.** The occlusion toggle asks for
 *    real-world depth. On a desktop browser there is no session and no depth,
 *    so the readout says exactly that rather than leaving you to wonder - which
 *    is the whole reason the reports exist.
 *
 * 6. **The room is a separate component.** The world-sensing director is wired
 *    below beside the environment one, shares nothing with it, and reports the
 *    same way. On a desktop browser it will say there are no planes because
 *    there is no session - which is the point.
 *
 * There is no audio file in the repository - see `cueSrc` below.
 */
import {
  BoxGeometry,
  Clock,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  TorusKnotGeometry,
  WebGLRenderer,
} from "three";
import { AudioListener } from "three";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";
import {
  createThreeAudio,
  createThreeEnvironment,
  createThreeWorldSensing,
  DEFAULT_OCCLUSION,
  NOON,
  SENSING_FEATURES,
  STOCK_PRESETS,
  WORLD_FEATURES,
} from "@realitycollective/threejs-environment";

const container = document.getElementById("scene-container") as HTMLDivElement;

const scene = new Scene();
const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 400);
camera.position.set(0, 1.6, 3);

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
container.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// --- something to light -----------------------------------------------------
// ALL of this is the app's, including the floor. The library describes the sky,
// the fog and the lights - platform facilities each engine exposes differently
// - and nothing that could be built here out of a geometry and a material.
// Deliberately plain: the point of the demo is the environment.
const floor = new Mesh(
  new PlaneGeometry(60, 60),
  new MeshStandardMaterial({ color: 0x282d33, roughness: 1 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const knot = new Mesh(
  new TorusKnotGeometry(0.4, 0.13, 160, 24),
  new MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.35, metalness: 0.1 }),
);
knot.position.set(0, 1.4, 0);
knot.castShadow = true;
scene.add(knot);

const plinth = new Mesh(
  new BoxGeometry(0.9, 0.9, 0.9),
  new MeshStandardMaterial({ color: 0x6e7885, roughness: 0.9 }),
);
plinth.position.set(0, 0.45, 0);
plinth.castShadow = true;
plinth.receiveShadow = true;
scene.add(plinth);

// --- the environment --------------------------------------------------------
const { director } = createThreeEnvironment(scene, {
  presets: STOCK_PRESETS,
  // Start somewhere with a horizon so the first transition has something to
  // move away from.
  initial: NOON,
  defaultTransition: { durationMs: 4000, easing: "easeInOut" },
  // The renderer is what makes the two sensor-backed features reachable. With
  // it the port can ask three.js whether the session granted depth; without it
  // the answer is always "unsupported", which is also worth seeing.
  renderer,
});

// The metal knot has something to reflect now. `room` is three.js's own
// RoomEnvironment when a prefilter is supplied and a neutral ramp when it is
// not, and this demo deliberately does not supply one - the difference is a
// dull sphere versus a lit one, which is easier to see than to describe.
director.apply({ ibl: { kind: "room", intensity: 0.8 } });

// --- the room ---------------------------------------------------------------
// A SECOND director, with its own port. Nothing about it touches the sky: it
// answers "what is actually in this room", which is placement's question and
// not the environment's. Detection is asked for here; the session still has to
// have been created with `plane-detection`, and the readout says when it was
// not.
const { director: world } = createThreeWorldSensing(renderer, {
  detection: { planes: true },
});
world.onChange((change) => {
  // What an app does with this is content: spawn something on a new surface,
  // drop it when the surface goes. The library reports; it never builds.
  if (change.added.length > 0) console.info("world:", change.feature, "added", change.added);
});

// --- the audio --------------------------------------------------------------
// No audio ships with this repository, so the cue points at a file you drop in
// yourself. With nothing there the port logs one warning and the rest of the
// demo carries on, which is the behaviour a missing sound should have.
const cueSrc = "/audio/hum.mp3";
const listener = new AudioListener();
camera.add(listener);
scene.add(camera);

const { director: audio, port: audioPort } = createThreeAudio(listener, {
  cues: [
    { id: "hum", src: cueSrc, bus: "ambience", loop: true, gain: 0.8 },
    { id: "chime", src: cueSrc, bus: "sfx", policy: "restart", minIntervalMs: 120 },
  ],
  busGains: { ambience: 0.6 },
});

// --- controls ---------------------------------------------------------------
const presets = document.getElementById("presets") as HTMLDivElement;
for (const name of director.presetNames()) {
  const button = document.createElement("button");
  button.textContent = name;
  button.addEventListener("click", () => {
    director.transition(name);
    // Any gesture is a good moment to unblock the audio context.
    void audioPort.resume();
  });
  presets.appendChild(button);
}

const passthroughButton = document.getElementById("passthrough") as HTMLButtonElement;
passthroughButton.addEventListener("click", () => {
  director.setPassthrough(!director.passthrough);
});

const occlusionButton = document.getElementById("occlusion") as HTMLButtonElement;
occlusionButton.addEventListener("click", () => {
  director.setOcclusion(director.occlusion === null ? DEFAULT_OCCLUSION : null);
});

const cueButton = document.getElementById("cue") as HTMLButtonElement;
cueButton.addEventListener("click", () => {
  void audioPort.resume().then(() => {
    audio.play("chime", { gain: 1 });
    if (audio.activeVoices.every((voice) => voice.cueId !== "hum")) audio.play("hum");
  });
});

const master = document.getElementById("master") as HTMLInputElement;
master.addEventListener("input", () => audio.setMasterGain(Number(master.value)));
const ambience = document.getElementById("ambience") as HTMLInputElement;
ambience.addEventListener("input", () => audio.setBusGain("ambience", Number(ambience.value)));

// The readout that makes an absent sensor visible. Without this, "occlusion is
// on and doing nothing" and "occlusion is working, nothing is in front of you"
// are the same picture.
const sensing = document.getElementById("sensing") as HTMLDivElement;
function describe(report: { state: string; detail?: string }): string {
  return `${report.state}${report.detail === undefined ? "" : ` (${report.detail})`}`;
}
function showSensing(): void {
  // Two directors, one vocabulary. The environment one answers for the
  // features it owns; the world one answers for the room.
  const environment = SENSING_FEATURES.filter(
    (feature) => !WORLD_FEATURES.includes(feature as (typeof WORLD_FEATURES)[number]),
  ).map((feature) => `${feature}: ${describe(director.getSensing(feature))}`);
  const room = WORLD_FEATURES.map((feature) => `${feature}: ${describe(world.getSensing(feature))}`);
  sensing.textContent = [...environment, ...room].join(" · ");
}
director.onSensing(showSensing);
world.onSensing(showSensing);
showSensing();

const state = document.getElementById("state") as HTMLDivElement;
director.onChange((applied, requested) => {
  const describe = (sky: typeof applied.sky) => (sky === null ? "none" : sky.kind);
  state.textContent =
    `sky applied: ${describe(applied.sky)} · asked for: ${describe(requested.sky)}` +
    (director.passthrough ? " · passthrough" : "");
});

// --- the loop ---------------------------------------------------------------
// The directors do not tick themselves; this is the whole of the wiring.
const clock = new Clock();
renderer.setAnimationLoop(() => {
  const deltaMs = clock.getDelta() * 1000;
  director.update(deltaMs);
  world.update(deltaMs);
  audio.update(deltaMs);
  knot.rotation.y += deltaMs * 0.0004;
  renderer.render(scene, camera);
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
