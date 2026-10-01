# @realitycollective/native-environment

The **native host adapter** for the Reality Collective WebXR Environment Extensions. For a native app - OpenXR on Quest, CompositorServices on visionOS, or any other shell - that embeds a JavaScript engine such as Hermes, owns rendering and audio itself, and installs one object, `globalThis.__rcHost`, before the bundle is evaluated. `src/native-types.ts` states every slice this package reads, with each member's units and meaning.

It re-exports the engine-free core, so this is the only package you install.

```bash
npm install @realitycollective/native-environment
```

It serves every port the core defines: the visual environment, sensing, world sensing, audio and scene management (`createNativeScenes` over the host's `scenes` slice), and ships `nativeEnvironmentHostConformanceCases()` to prove a host on its device.

## Tested on a headset

A native app built with this package passed on a Meta Quest 3 on 1 October 2026, played by a person and checked by its conformance kit. No known issues.

## No asset decoding here

Specs cross this boundary unchanged, because they are already plain data: numbers, strings, booleans and nested objects. A `src` string - a sky texture, an environment map, an audio cue - means the same thing it does on every other host, a URL or a path relative to the app's content root, and the **native app** resolves and decodes it with its own loaders. Nothing in this package fetches, decodes or caches an image, a sound or a model.

## Use

```ts
import { createNativeEnvironment, createNativeAudio, STOCK_PRESETS } from "@realitycollective/native-environment";

// Reads globalThis.__rcHost.environment / .audio. Pass a host in directly for tests.
const { director } = createNativeEnvironment(undefined, { presets: STOCK_PRESETS, initial: STOCK_PRESETS.noon });
const { director: audio } = createNativeAudio();

director.transition("dusk", { durationMs: 8000, easing: "easeInOut" });
audio.register({ id: "click", src: "audio/click.mp3" });

// Nothing here ticks itself. `onFrame` is the root service-framework-native
// slice, not this package's; wire the director into whatever already runs
// once per frame on your host.
host.onFrame((_, deltaS) => director.update(deltaS * 1000));
```

## What the adapter does

- **Sky, fog, ambient and key light, and image-based lighting** forward straight to `__rcHost.environment`'s five required methods. There is nothing to convert: the director has already resolved the interpolation and the mix.
- **Depth occlusion and light estimation** are grown on the port only when the host implements `applyOcclusion` / `applyLightEstimation`. A host without one simply does not get the method, and `EnvironmentDirector` reports `unsupported` the moment an app asks for it - the same mechanism every adapter in this estate uses, just without an intermediate check of its own.
- **Sensing reports and light estimates** arrive by subscribing to the host's own `onSensingReport` / `onLightEstimate`, when it has them, and forwarding each one to the director unread. The **native app** decides what `active` or `unavailable` means on its platform; this package does not interpret device state.
- **Audio** keeps every voice's `ended` callback in JavaScript, keyed by `voiceId`, because a callback the CORE hands to a port cannot cross this boundary - only a listener callback the host itself calls can. `start` sends the host a request with `ended` removed; the callback runs once, when `onVoiceEnded` names that id, and `stop` never reaches the host for a voice that already has. `onVoiceEnded` is the only signal this port ever gets about a voice, so a host that fails to start one and forgets to report it leaves that voice invisible - there is no separate "it started" message to notice the absence of. `NativeAudioPort` therefore backs every voice with the same `AudioStartReaper` every platform in this family shares (`NativeAudioPortOptions.startTimeoutMs`, 10 s by default): a non-looping voice with no `durationMs` that the host has not reported on either way is released locally once the timeout elapses. A real host should still report a failed start promptly - this is the backstop for one that forgets, not a replacement for reporting it.
- **World sensing** - `createNativeWorldSensing` forwards to `__rcHost.sensing` one member at a time, exactly as occlusion and light estimation do. A host with no `sensing` slice at all is a normal, supported shape: every call is reported `unsupported` by `WorldSensingDirector` rather than this package refusing to exist.
- **Scenes** - `createNativeScenes` puts the core's `SceneManager` over `__rcHost.scenes`. The native app builds each scene from its `src` with its own loaders, and physics from the physics components in it, and reports poses through the `interactions` slice as now. Scenes and nodes cross as the app's own string keys. A node's key is also its target id in the `interactions` slice, so an interaction target registered against a scene node resolves to that node. Hidden, for a scene or a node, means neither rendered nor hit-testable.

```ts
interface NativeScenesHost {
  build(def: SceneDefinition, visible: boolean): Promise<{ scene: string; nodes: { id: string; key: string }[] }>;
  setVisible(scene: string, visible: boolean): void;
  destroy(scene: string): void;
  setNodeActive(node: string, active: boolean): void;
  instantiate(asset: string, pose: WorldPose, scene: string, parent: string | null): string;
  destroyInstance(instance: string): void;
  detachNode(scene: string, node: string): void;   // persistent: out of the scene's lifetime
  destroyNode(node: string): void;
  onBuildProgress?(cb: (sceneId: string, progress: number) => void): () => void;
}
```

The rules (single, additive, the stack, the active scene, preload, ordering, persistence, disposal) are the core's, so the app implements none of them. `test/helpers.ts` has `createFakeScenesHost`, an in-memory app that conforms, and `test/scene-port.test.ts` runs `sceneManagerContractCases()` over it.

## The four slices, and what happens when one is missing

| Slice | Required by | Missing |
| --- | --- | --- |
| `environment` | `NativeEnvironmentPort` | Throws at construction, naming the slice |
| `audio` | `NativeAudioPort` | Throws at construction, naming the slice |
| `sensing` | `NativeWorldSensingPort` | Never throws - every call reports `unsupported` |
| `scenes` | `NativeScenePort` | Throws at construction, naming the slice |

Every constructor also takes the slice directly, for tests: `new NativeEnvironmentPort(fakeHost)` never touches `globalThis`.

## Proving a host: the conformance kit

`nativeEnvironmentHostConformanceCases()` returns the host cases, as runner-free data named `environment/<row>` and `audio/<row>`. A native app runs them on its device against its real slices and the test readbacks of `NativeEnvironmentTestHost` and `NativeAudioTestHost` (`voices()`).

`NativeEnvironmentTestHost` has two kinds of readback, and the difference matters: `applied(slot)` and `appliedOcclusion()` report what the host was HANDED, proving a value crossed the boundary correctly; `drawnSkyKind()`, `drawnFogKind()`, `drawnKeyLightCastsShadow()`, `drawnIblActive()` and `appliedLightEstimation()` report what the host is actually DRAWING, derived from its own rendering state. A host can echo a gradient sky back through `applied("sky")` correctly and still be painting a flat colour underneath - only the second kind of readback catches that, which is why the cases below exist as well as the ones that only check `applied`:

- every sky kind (`solid`, `gradient`, `texture`) is drawn as the kind it was given, not flattened to one;
- every fog kind (`linear`, `exponential`) likewise;
- a key light's `castShadow` actually turns the host's shadow on, and off;
- an ibl spec makes materials reflect it, and `null` turns that back off;
- light estimation reaches `applyLightEstimation` with the resolved request, and once the host measures something, `onLightEstimate` overlays ambient, key and ibl. A host with neither method, or one that reports the feature unavailable instead of ever measuring, is accepted - that is a legitimate way not to support this on a given device. Only a host that has both methods and silently does nothing with them fails.

```ts
for (const hostCase of nativeEnvironmentHostConformanceCases()) {
  await hostCase.run({
    environment: __rcHost.environment,
    environmentTest: __rcShell.testHost,
    audio: __rcHost.audio,
    audioTest: __rcShell.testHost,
    cueSrc: "sounds/click.ogg",
  });
}
```

Each case drives the real core director over the host and reads back what the host draws or sounds. A host with no `applyOcclusion`, or no `audio` slice, fails the cases that need them.

## License

MIT - see [LICENSE](./LICENSE).
