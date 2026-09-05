# @realitycollective/webxr-environment

The engine-free core of the Reality Collective **WebXR Environment Extensions**: the platform features that make up the world around the player, and the playback of sound.

You do not install this package directly. Install the adapter for the engine you already use - [`@realitycollective/threejs-environment`](https://www.npmjs.com/package/@realitycollective/threejs-environment) or [`@realitycollective/iwsdk-environment`](https://www.npmjs.com/package/@realitycollective/iwsdk-environment) - and it re-exports everything here.

## What it is

Two directors and two ports.

- **`EnvironmentDirector`** owns a sky, fog, an ambient light and a key light, described as plain data. It interpolates between named presets, pushes only what changed to the adapter, and suppresses the sky and fog while passthrough is showing.
- **`AudioDirector`** owns a cue registry, a bus mix, the retrigger policy and the voices. The adapter is handed a resolved absolute gain and told to make a noise.

Every slot is a **platform facility** each host exposes differently - three.js has `scene.background` and `Fog`, IWSDK has `DomeGradient` and `AmbientLightComponent`, the next host will have something else. Presenting one description all of them can be driven from is the whole job.

Neither owns a loop. `update(deltaMs)` is called by whatever already runs per frame, which is what makes an eight-second dusk a five-line unit test rather than a stopwatch and a headset.

## What it is not

- **Not a session or capability layer.** It never reads `navigator.xr`. Passthrough arrives through `setPassthrough(boolean)`, pushed in by whatever already tracks it - on this stack, the service framework.
- **Not content.** No geometry, no meshes, no prefabs, no placement, no floors. If a thing could be built by the app out of a geometry and a material, it does not belong here. Art direction is the app's too: the stock presets are examples to copy, not an opinion about how your world should look.
- **Not an event source.** It plays sounds when asked; it has no notion of why.

One name to keep straight: `@realitycollective/service-framework` exports an `EnvironmentDescriptor`, which means the PLATFORM environment the app is running in - a name plus a set of capability strings. The `EnvironmentSpec` here means the VISUAL environment: the sky, the fog and the light. Unrelated concepts, and an app can hold both.

The architecture test asserts the first of those and the dependency rule behind them: this package has **no runtime dependencies at all**, and no sibling package is imported, named in a type, or asserted against in a test.

## Playing a sound when something happens

`play(cueId, options?)` is the whole inbound surface, and **the app does the binding**:

```ts
const stop = someEmitter.on("thing", () => audio.play("click"));
```

That is the integration, in the app, where both halves are already in scope. Swap the emitter for an interaction event, a level change, a socket message - the line looks the same, and nothing here knows which it was. If the source is present it gets bound; if it is not, nothing happens.

A caller's `gain` is **relative**: the bus and master gains still apply over it, so whatever is bound is a peer and never an owner of the player's mix.

## Specs are partial

```ts
director.apply({ fog: null });        // clears the fog, touches nothing else
director.apply({ sky: DUSK.sky });    // changes the sky, keeps the lighting
```

An omitted slot inherits; an explicit `null` turns the slot off. That is what makes presets composable.

## The one interpolation rule

A slot interpolates only when both ends describe the **same kind** of thing. A slot appearing, a slot disappearing, or a linear fog becoming exponential takes the target value at `t = 0` and holds it.

There is no honest halfway point between "fog" and "no fog". To ease fog **in**, make both ends fogs:

```ts
director.apply({ fog: clearedFog(DUSK.fog!) });          // present, but invisible
director.transition({ fog: DUSK.fog! }, { durationMs: 4000 });  // rolls in
```

## Licence

MIT. Part of the [Reality Collective](https://github.com/realitycollective) WebXR stack.
