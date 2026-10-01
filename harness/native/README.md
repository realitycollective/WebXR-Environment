# Native test harness (Environment)

A native app built from this repository's own source that runs the Environment family's suites against a real native host on the device, and gives a person wearing the headset a timed tour of the family's behaviour: presets, positional sound, world sensing requests and scene loading. It exists so a defect in a native host, or in the native binding, is found here before a client project runs into it.

The harness is a project for the WebXR-to-native conversion pipeline (the Reality Collective's `WebXR-Native-Pipeline` repository): `app.json` describes it, `entry.ts` is its native entry, `scene-assets.ts` and `scenes/` are its content. The pipeline bundles the entry to Hermes bytecode through its gates (no three.js or `@iwsdk` in the bundle, only the host-profile globals), cooks the tour's meshes to glTF, generates the Android project and builds the APK. Nothing in the pipeline names this project; it is handed this folder.

## Modes

The shell launches the app with `debug.rc.mode` set (`adb shell setprop debug.rc.mode kits`); a runner under Node sets `__rcShell.mode` before it loads the bundle.

| Mode | What runs | Where the result goes |
| --- | --- | --- |
| `kits` | `environmentPortContractCases`, `audioPortContractCases`, `worldSensingPortContractCases`, `sceneManagerContractCases` and `nativeEnvironmentHostConformanceCases`, against `__rcShell.testHost` on a device or the reference fakes under Node | one JSON line per suite (`step: "suite"`), then `step: "done"` with `pass`, the skipped suites and every failure named |
| `play` | the timed tour below, over the live `__rcHost`, looping until the app closes; a person wears the headset | one JSON line per change (`step: "step"`), and a `status` line once a second |

`kits` is the default with no native host, `play` the default on a device.

A suite the shell's test host cannot serve is reported as a `suite` line with `skipped` and a `reason`. It is not a pass and not a failure. The world sensing port suite is skipped when the test host has no `sensing` slice. The audio port suite is skipped when the test host has no driver that ends a voice as the host would, which is the case for the shell's audio slice. Under Node both run against the fakes.

## The tour

The tour steps through the six stock presets, one every 8 seconds, and loops. Each step moves to the preset with a 3 second eased transition (`easeInOut`), so the last 5 seconds of a step show the finished preset. Every step line carries `at` (the display time in milliseconds), `name`, and the loop number, so a tester's note ("the sky went grey at about a minute") can be matched to the log by time and name.

| Step | Time in the loop | Preset | Cue (1.5 m from the head, level) | Also |
| --- | --- | --- | --- | --- |
| 0 | 0 s | `void` | ahead | requests depth occlusion, light estimation and plane detection; unloads scene A from the last loop |
| 1 | 8 s | `dawn` | left | single load of scene A; on the first loop, spawns the beacon and makes it persistent |
| 2 | 16 s | `noon` | right | |
| 3 | 24 s | `dusk` | ahead | additive load of scene B, which becomes the active scene |
| 4 | 32 s | `night` | left | |
| 5 | 40 s | `overcast` | right | releases the sensing requests; unloads scene B, which returns the active scene to A |

A loop is 48 seconds. Scene A is a block and a ring to the left, scene B a pillar and a ball to the right, and the beacon is a small octahedron above them that stays for the whole run once created. The cue is `kit://tick.wav`, a positional voice placed from the head's pose at the moment of the step, so ahead, left and right are relative to where the tester is looking.

Step names in the log: `preset:<name>`, `cue`, `sensing-request`, `sensing-release`, `scene-load-single`, `scene-load-additive`, `scene-loaded`, `scene-persist`, `scene-unload`. Other lines: `sensing` (every report from the environment director and the world sensing director), `scene-event` (loaded, unloaded, active scene changed), `error`, and `status`. A `status` line names the preset, whether a transition is running, the scenes loaded, the active scene, the voices playing and the sensing states.

Depth occlusion is remembered by the director and applied to the host when passthrough starts. The tour does not switch passthrough on, so on an opaque session the occlusion request shows up in the sensing reports rather than on screen. A slice the host does not carry is skipped and logged once: no `audio` means no cues, no `scenes` means no scene steps, no `sensing` means no plane detection.

## Building

CI compiles the harness and never runs it: a native build runs only on a developer's machine or a headset.

```
npm run harness:compile
```

That typechecks the harness, bundles `entry.ts` with esbuild (no browser, no engine, the host-profile gate) to `build/node/harness.js`, and compiles the bundle to Hermes bytecode with the flags the pipeline uses, so a bundle the device's engine would refuse fails the build. `--require-hermes` fails when `hermes-compiler` is missing instead of skipping that step; CI passes it. The gate also fails a bundle that contains a test runner, or a test file that imports one.

`npm run harness:scenes` rewrites `scenes/*.iwsdk.scene.json` from `src/tour-layout.ts`, the one list of parts that `scene-assets.ts` also cooks. Run it after changing the layout and keep the generated files.

With no `__rcHost` installed, the bundle uses this repository's reference fakes (`src/fakes.ts`), so a local runner can load it in Node and drive `__rcTick` to prove the kits pass on the fakes.

For a device, the conversion pipeline builds the APK from `app.json` (`rc check`, `rc assets`, `rc build --target quest`). The pipeline takes each Reality Collective package from this repository's `node_modules` first, so the harness is built from this working tree once `npm run build` has run, and the rest from its own install. To build against other families' working trees as well, name their `packages/` folders in `RC_PACKAGES`. Nothing is copied over an install.

## What the shell must provide

The root contract (`__rcHost.onFrame`, `__rcTick`) and the `environment`, `audio`, `scenes` and, optionally, `sensing` slices of `@realitycollective/native-environment` (`native-types.ts`), plus `input.getHeadPose` for the cue placement (a standing head facing -Z is used without it). The pipeline packs `kit://sky.hdr` and `kit://tick.wav` for every app. For `kits`, `__rcShell.testHost` with `environment`, `audio` when the host has a mixer, `scenes`, `input` and `resetEnvironment()`, and `readbacks.environment` and `readbacks.audio` implementing `NativeEnvironmentTestHost` and `NativeAudioTestHost`. The test `scenes` slice adds `defineFixtures(fixtures)`, `reset()` and `inspect` (`exists`, `isShown`, `isHitTestable`, `worldPosition`, `liveCount`), all by node key. The `scenes` slice resolves scene sources of the form `/scenes/<name>.iwsdk.scene.json` and the asset name `tour-beacon`.

## Output

Everything the compile and the pipeline write goes under `build/`, which is ignored. Device logs and results are kept outside this repository.
