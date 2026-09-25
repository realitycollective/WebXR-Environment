# @realitycollective/webxr-environment

The engine-free core of the Reality Collective **WebXR Environment Extensions**: the platform features that make up the world around the player, and the playback of sound.

You do not install this package directly. Install the adapter for the engine you already use - [`@realitycollective/threejs-environment`](https://www.npmjs.com/package/@realitycollective/threejs-environment) or [`@realitycollective/iwsdk-environment`](https://www.npmjs.com/package/@realitycollective/iwsdk-environment) - and it re-exports everything here.

## What it is

Two directors and two ports.

- **`EnvironmentDirector`** owns a sky (gradient, solid colour or an authored image), fog, an ambient light, a key light and an environment map for image-based lighting, described as plain data. It interpolates between named presets, pushes only what changed to the adapter, and suppresses the sky and fog while passthrough is showing.
- **`EnvironmentDirector`** also owns the two sensor-backed features. `setOcclusion(spec)` asks for real-world depth and reaches the port only while passthrough is on; `setLightEstimation(true)` lets the host's measurement of the room take over the ambient, key and ibl slots while it is measuring, as a layer over what the app asked for rather than an edit to it. `setPassthrough` takes a WebXR blend mode as well as a boolean, because `additive` displays add what you draw to the real world and a dark fog is then invisible.
- **The sensing seam.** A port reports back through `observe(host)`: `unsupported`, `unavailable`, `pending` or `active` per feature, each with a sentence for a human, plus measured lighting. Read it with `getSensing(feature)` and `onSensing(listener)`. It exists because a sensor that is doing nothing looks exactly like a sensor that is working, and the rule that keeps it honest is that a report never changes what the app asked for - only what the app can be told.
- **`WorldSensingDirector`** is the other half, and deliberately a separate object: it asks for planes, meshes and anchors, keeps the registries, runs standing hit tests, and emits what appeared, moved and went away. It reports what the host measured and builds nothing - the mesh you draw on a detected wall is yours.
- **Sound has a direction as well as a distance.** A cue's `spatial.cone` says how narrowly it points and a play's `facing` says which way this one is turned, in radians and as a travel direction - the package's own terms, converted by each adapter to the degrees and the +Z forward its host happens to want.
- **`AudioDirector`** owns a cue registry, a bus mix, the retrigger policy and the voices. The adapter is handed a resolved absolute gain and told to make a noise.
- **`SceneManager`** manages scenes inside one session, because a WebXR app cannot change scene by changing page. See [Managing scenes](#managing-scenes).

Every slot is a **platform facility** each host exposes differently - three.js has `scene.background` and `Fog`, IWSDK has `DomeGradient` and `AmbientLightComponent`, the next host will have something else. Presenting one description all of them can be driven from is the whole job.

Neither owns a loop. `update(deltaMs)` is called by whatever already runs per frame, which is what makes an eight-second dusk a five-line unit test rather than a stopwatch and a headset.

## What it is not

- **Not a session or capability layer.** It never reads `navigator.xr`. Passthrough arrives through `setPassthrough(boolean)`, pushed in by whatever already tracks it - on this stack, the service framework.
- **Not content.** No geometry, no meshes, no prefabs, no placement, no floors. If a thing could be built by the app out of a geometry and a material, it does not belong here. `SceneManager` loads a scene's `src` through the host's own loader and never reads what is in it. Art direction is the app's too: the stock presets are examples to copy, not an opinion about how your world should look.
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

## Managing scenes

`SceneManager` holds the rules and a `ScenePort` per host builds and destroys the content. Scenes are a list, like Unity's build settings; services load them by id and every host does it its own way.

```ts
const { manager } = createThreeScenes(scene, { environment: director, assets: (name) => prefabs[name].clone() });
manager.register([
  { id: "lobby", src: "/scenes/lobby.glb", environment: "dusk" },
  { id: "court", src: "/scenes/court.glb" },
]);
await manager.load("lobby");                                  // single: replaces what is loaded
manager.makePersistent("lobby", "hud");                       // survives single loads
await manager.load("court", { mode: "additive" });            // adds to the top of the stack
await manager.load("level-3", { activate: false });           // preload: built, hidden
manager.activate("level-3");                                 // instant switch
const id = manager.instantiate("ball", pose);                 // into the active scene
manager.bindNode("court", "tee", (node) => registerTarget(node)); // released on unload
```

- **Single** unloads every loaded scene, keeping persistent nodes, then loads. Unloaded events fire before the loaded event.
- **Additive** adds to the top of the stack and changes nothing else. **Unload** removes any scene in the stack; the rest keep their order, its instances go with it and its persistent nodes do not.
- **The active scene** is where `instantiate` puts new objects, and its `environment` drives the director with a transition, exactly as a preset change does. Unloading it makes the top shown scene active, or none.
- **Preload** (`activate: false`) builds a scene that is neither shown nor hit-testable until `activate`. That is how native gets an instant switch and the web a fetch hidden behind a fade. A preloaded single load replaces the other scenes when it is activated.
- **Loads and unloads run in call order.** Loading a scene already loaded or loading returns the same promise; an id not in the list rejects.
- **Node ids are unique within a scene**, and an instance id addresses its instance as a node of the scene it was spawned into. A persistent node moves to `PERSISTENT_SCENE_ID`. `bindNode` ties something such as an interaction target to a node while its scene is shown, and releases it when the scene unloads.
- **`dispose`** leaves nothing on the host: no scenes, instances, persistent nodes, bindings, listeners or environment overrides.

The adapters are `createThreeScenes`, `createIWSDKScenes` (IWSDK's own `SceneJSONImporter`, beside `world.loadLevel` rather than replacing it), `createXRBlocksScenes` and `createNativeScenes` (the `scenes` slice on `__rcHost`).

## Proving a new adapter conforms

`environmentPortContractCases()`, `audioPortContractCases()` and `worldSensingPortContractCases()` are the `EnvironmentPort`, `AudioPort` and `WorldSensingPort` conformance suites, shipped as data rather than as tests. Each case is a `name` plus a `run(subject)` that returns silently on success and throws an `Error` describing the failure otherwise, so an adapter runs them in whatever test runner it already has. They ship runner-free because an adapter written outside this repository cannot reach into this one's `test/` folder.

An adapter's test file is a loop:

```ts
import { environmentPortContractCases } from '@realitycollective/webxr-environment';

for (const contractCase of environmentPortContractCases()) {
  it(contractCase.name, () => contractCase.run({ port: makeMyEnvironmentPort() }));
}
```

`makeMyEnvironmentPort()` (or the audio/world-sensing equivalent) runs once per case, because a case applies slots or starts voices and does not clean up after itself. The audio suite also takes a `driver`: something with `end(voiceId)` that makes the host finish a voice as though it stopped on its own, which is how the suite checks a one-shot's `ended` fires exactly once without depending on your engine's timing. `sceneManagerContractCases()` is the fourth, and different in kind: it runs the real `SceneManager` over your real `ScenePort`, because the rules are what every host promises and the port is where a host can break them. You build the fixture scenes in `SCENE_CONTRACT_FIXTURES` with your host's own objects and hand the suite an inspector that answers from the host itself: does a node exist, is it shown, would the host's own hit testing find it, where is it, and how many objects has the port left behind.

```ts
for (const contractCase of sceneManagerContractCases()) {
  it(contractCase.name, () => contractCase.run({ create: (fixtures) => makeMySceneHost(fixtures) }));
}
```

`threejs-`, `iwsdk-`, `xrblocks-environment` and `native-environment` all run all four suites - `xrblocks-environment`'s audio suite runs against what `createXRBlocksAudio` returns, since that adapter reuses `ThreeAudioPort` outright - so a case failing on yours is a real difference in behaviour, not a difference in test style.

## Licence

MIT. Part of the [Reality Collective](https://github.com/realitycollective) WebXR stack.
