# @realitycollective/iwsdk-environment

The **Meta IWSDK adapter** for the Reality Collective WebXR Environment Extensions. Re-exports the engine-free [`@realitycollective/webxr-environment`](https://www.npmjs.com/package/@realitycollective/webxr-environment) core, so this is the only package you install.

```bash
npm install @realitycollective/iwsdk-environment
```

## Use

Setup is one call, and it registers the system that ticks the directors:

```ts
import {
  registerEnvironment,
  STOCK_PRESETS,
  VOID,
} from "@realitycollective/iwsdk-environment";

const env = registerEnvironment(world, {
  presets: STOCK_PRESETS,
  initial: VOID,
  audio: {
    cues: [{ id: "hum", src: "/audio/hum.mp3", bus: "ambience", loop: true }],
  },
});

env.environment.transition("dusk", { durationMs: 8000 });
```

Because the tick is an IWSDK system, the environment stops advancing when the session loses focus, exactly like the rest of the app. IWSDK hands systems a delta in **seconds** and the directors take **milliseconds**; that conversion happens once, inside the system.

## What the adapter does

It drives IWSDK's own machinery rather than reaching past it to three.js:

- **Sky** - a `DomeGradient` on the level root. IWSDK's `EnvironmentSystem` already hides authored backgrounds in an AR session, which is behaviour worth inheriting rather than fighting. A gradient's equator is derived from the same ramp the three.js adapter uses, so the two engines agree at the horizon and not only at the poles.
- **Lights** - `AmbientLightComponent` and `DirectionalLightComponent` on transform entities. The key entity is rotated so its local `-Z` runs along the direction the light travels.
- **Image-based lighting** - `IBLGradient` and `IBLTexture`. `kind: "room"` is native here: IWSDK's own component takes the string `"room"` for its built-in probe, so the one kind three.js has to approximate is the one this host has for free.
- **Authored skies** - `DomeTexture`, with blurriness and rotation. The gradient dome is removed rather than left underneath, so the two never fight over the background.
- **Depth occlusion** - `DepthSensingSystem` for the system-level settings and `DepthOccludable` per entity. IWSDK opts entities in one at a time by patching their materials, so `scope: "all"` needs an `occludables` option naming which entities the real world may hide - the entities are content, and content is yours. Whatever the port adds it remembers, so turning occlusion off never strips a component you added yourself. Without that option it reports `unavailable` and says so.
- **Light estimation** - none. IWSDK 0.5.3 has no WebXR light estimation at all, and the port reports `unsupported` with that sentence rather than going quiet. Filed upstream as item 6.1. An `ibl: { kind: "estimated" }` asked for here is refused the same way, and the environment map you set yourself is left where it was.
- **The room** - hits carry no distance here, because IWSDK moves a target entity to the hit and keeps the ray to itself; guessing from the head would be a different number wearing the same name. `IWSDKWorldSensingPort` queries the entities IWSDK's `SceneUnderstandingSystem` already created rather than reaching past it to the session, so planes, meshes and anchors come with IWSDK's own measurements. A hit test becomes an entity carrying `EnvironmentRaycastTarget`, which is how IWSDK casts; creating an anchor means creating an entity with `XRAnchor`, which is how IWSDK anchors.
- **Audio** - one entity per voice, carrying `AudioSource` with `playbackMode` pinned to `Overlap`, plus the cue's own reference distance, rolloff, maximum distance, `DistanceModel` and cone. IWSDK hands the entity transform to the same three.js positional audio the other adapter uses, so a `facing` turns the entity and the cone angles are written in degrees. The core has already applied the cue's retrigger policy, and letting IWSDK apply its own on top would make `restart` mean two different things on two engines.

Every one of those is an IWSDK platform component with no app-side equivalent. The adapter creates **no geometry**: a floor would be a mesh, and meshes are the app's.

**Fog is the exception.** IWSDK has no fog component, so it is set on `world.scene` directly, with `Fog` / `FogExp2` imported from `three`, a declared peer. Importing them through `@iwsdk/core`'s `export * from 'three'` looked equivalent, but a consumer that excludes `three` from Vite's dependency optimizer cannot resolve names that only exist behind that star.

## Knowing when a sound finished

IWSDK reports whether a source *is* playing, never that it has just stopped. So the port polls in the tick it is already given, and reports the end once a voice has been seen playing and then is not. A voice that never starts at all - a missing file, a failed decode - is reaped after `startTimeoutMs` (10 s by default) with a warning, rather than being tracked forever.

## Passthrough

Push it in; do not expect the package to find it:

```ts
// `adapter` is the service framework's RuntimeAdapter; the flag it reports is
// derived from the LIVE session, not from what was requested.
adapter.onCapabilitiesChange((c) => env.environment.setPassthrough(c.passthrough));
```

A session belongs to the platform layer, not to the environment. `setPassthrough(true)` suppresses the sky and fog on top of whatever the app asked for, and turning it off restores exactly what was there - nothing has to remember what to put back.

## Peer dependencies

`@iwsdk/core >= 0.5.0 < 0.6.0`, developed and tested against 0.5.3.

`three >= 0.170.0`, which every IWSDK application already carries (IWSDK projects alias it to `super-three`). The adapter imports three.js classes from `three` directly rather than through `@iwsdk/core`'s star re-export, so it prebundles even when an application excludes `three` from Vite's dependency optimizer to transform its source.

## Licence

MIT.
