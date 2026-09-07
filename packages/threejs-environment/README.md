# @realitycollective/threejs-environment

The **three.js adapter** for the Reality Collective WebXR Environment Extensions. Re-exports the engine-free [`@realitycollective/webxr-environment`](https://www.npmjs.com/package/@realitycollective/webxr-environment) core, so this is the only package you install.

```bash
npm install @realitycollective/threejs-environment three
```

## Use

```ts
import {
  createThreeAudio,
  createThreeEnvironment,
  STOCK_PRESETS,
} from "@realitycollective/threejs-environment";

const { director } = createThreeEnvironment(scene, {
  presets: STOCK_PRESETS,
  initial: STOCK_PRESETS.noon,
  defaultTransition: { durationMs: 4000, easing: "easeInOut" },
});

const listener = new AudioListener();
camera.add(listener);
const { director: audio, port: audioPort } = createThreeAudio(listener, {
  cues: [{ id: "hum", src: "/audio/hum.mp3", bus: "ambience", loop: true }],
});

renderer.setAnimationLoop(() => {
  const deltaMs = clock.getDelta() * 1000;
  director.update(deltaMs);   // neither director ticks itself
  audio.update(deltaMs);
  renderer.render(scene, camera);
});

director.transition("dusk");
```

## What the adapter does

- **Sky** - a solid colour becomes `scene.background`; a gradient becomes a two-pixel-wide equirectangular `DataTexture`, regenerated in place across a transition rather than reallocated per frame. No shader, no canvas, and the ramp itself is a pure function (`skyMix`, `gradientPixels`) so it is unit tested with no renderer involved.
- **Fog** - `Fog` and `FogExp2`, mutated in place while the kind is unchanged.
- **Lights** - an `AmbientLight` and a `DirectionalLight`, positioned from the direction light *travels* (`[0, -1, 0]` is overhead).
- **Image-based lighting** - `scene.environment`, `environmentIntensity` and `environmentRotation`. A gradient reuses the generated ramp; an image is loaded through the injectable loader (pass an `RGBELoader` for HDR); `kind: "room"` uses three.js's `RoomEnvironment` when you supply a `prefilter`, and a neutral ramp when you do not, because prefiltering needs a renderer this port deliberately does not hold.
- **Depth occlusion** - three.js's OWN depth sensing, which has drawn an occlusion mesh before the scene since r158. Pass `renderer` in the options; the port then decides whether the request can be served (a session, `depth-sensing` enabled, gpu-optimized depth, a scope three.js can honour) and reports the reason when it cannot. There is no hand-rolled depth pass here on purpose: duplicating the renderer's GL state handling is how caches start lying.
- **Light estimation** - a WebXR light probe, read from the current `XRFrame` and converted to ordinary ambient and key specs. Not `XREstimatedLight`, so the estimate is data the app can read, blend or ignore rather than two lights in a `Group` only the renderer can see. Pass a `reflection` hook - two lines around `XRWebGLBinding.getReflectionCubeMap` - and the measured cube map arrives as `ibl: { kind: "estimated" }` too; without one, ambient and key still work and the report says the reflections were not measured.
- **The room** - `createThreeWorldSensing(renderer)` reads planes, meshes, anchors and hit-test results straight from the `XRFrame`, in the reference space three.js draws in, so a pose can be handed to `object.position.set(...)` unchanged. A mesh is measured once per `lastChangedTime`, because the alternative is walking a room scan every frame. A hit test with `space: "left"` or `"right"` is cast from that hand's own `targetRaySpace` - it waits while there is no such input source and unbinds when the hand goes - and every hit carries the distance from where the ray started.
- **Audio** - `Audio` / `PositionalAudio` over the listener's Web Audio context, with per-cue reference distance, rolloff, maximum distance, distance model and cone. A cue with a `cone` and a play with a `facing` become `setDirectionalCone` plus a turned holder: radians in the contract, degrees at the panner, +Z pointed the way the sound travels.

Everything the port creates is parented under one named `Group` (`port.root`), and `dispose()` gives all of it back. It creates **no geometry** - every one of those is a three.js facility with no app-side equivalent. A floor is a mesh, so a floor is yours; `demos/playground` builds its own in four lines.

## Two things worth knowing

**The first press is not silent.** A play that arrives before its buffer has decoded is held and started when the decode lands, unless it was stopped in the meantime. Dropping it instead is the reason the first press of every button in a session so often makes no sound.

**Autoplay.** Browsers refuse to start an `AudioContext` outside a user gesture. Call `audioPort.resume()` from the same handler that enters XR (or from your Enter-VR button) - a suspended context makes every voice silently succeed.

## Peer dependency

`three >= 0.170.0`. Meta's `super-three` fork satisfies this and is what the workspace develops against.

## Licence

MIT.
