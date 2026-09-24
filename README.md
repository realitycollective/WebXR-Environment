# WebXR Environment

| Branch | Build | Publish | Published on npm |
| --- | --- | --- | --- |
| `main` | [![main build](https://img.shields.io/github/actions/workflow/status/realitycollective/WebXR-Environment/ci.yml?branch=main&label=build)](https://github.com/realitycollective/WebXR-Environment/actions/workflows/ci.yml?query=branch%3Amain) | [![main publish](https://img.shields.io/github/actions/workflow/status/realitycollective/WebXR-Environment/publish-npm.yml?branch=main&label=publish)](https://github.com/realitycollective/WebXR-Environment/actions/workflows/publish-npm.yml?query=branch%3Amain) | [![npm latest](https://img.shields.io/npm/v/@realitycollective/webxr-environment/latest?label=npm%20latest)](https://www.npmjs.com/package/@realitycollective/webxr-environment?activeTab=versions) |
| `development` | [![development build](https://img.shields.io/github/actions/workflow/status/realitycollective/WebXR-Environment/ci.yml?branch=development&label=build)](https://github.com/realitycollective/WebXR-Environment/actions/workflows/ci.yml?query=branch%3Adevelopment) | [![development publish](https://img.shields.io/github/actions/workflow/status/realitycollective/WebXR-Environment/publish-npm.yml?branch=development&label=publish)](https://github.com/realitycollective/WebXR-Environment/actions/workflows/publish-npm.yml?query=branch%3Adevelopment) | [![npm preview](https://img.shields.io/npm/v/@realitycollective/webxr-environment/preview?label=npm%20preview)](https://www.npmjs.com/package/@realitycollective/webxr-environment?activeTab=versions) |

WebXR Environment describes the world **around** the player - the sky, the fog, the light - and the **sound** in it, as plain data, and applies that description through a thin adapter for whichever engine is hosting.

Every one of those is a **platform facility** that each host exposes differently: 

- Three.js has `scene.background` and `Fog`
- IWSDK has `DomeGradient` and `AmbientLightComponent`

additional hosts will have something else again. Simplifying the use of those, whichever headset and shim the title happens to be running on, is the entire job.

> [!NOTE]
> **Content is never here.**
> Meshes, prefabs, placement, floors, art direction - those belong to the app, which is the thing running the title and giving it direction. If something could be built by the app out of a geometry and a material, it does not belong in this repository.

Two words appear throughout:

- **Environment** - the setting: what the sky looks like, how far you can see, what colour the light is.
- **Cue** - a sound the app knows how to make, played by name.

This is the fifth family in the Reality Collective WebXR stack, and it exists because the first four deliberately stop short of it. It was extracted from a shipped client's gaps report, not designed in the abstract.

## Packages

Install exactly one adapter. Each one re-exports the core, so you never install the core yourself.

| Package | What it is |
| --- | --- |
| `@realitycollective/webxr-environment` | The core. Environment and audio logic, with no 3D engine code and **no dependencies at all**. |
| `@realitycollective/threejs-environment` | Adapter for plain three.js and raw WebXR. No other framework needed. |
| `@realitycollective/iwsdk-environment` | Adapter for Meta's Immersive Web SDK, driving IWSDK's own environment, lighting and audio machinery. |
| `@realitycollective/xrblocks-environment` | EXPERIMENTAL adapter for Google XR Blocks. Builds on the three.js adapter and adds XR Blocks' depth occlusion and light estimation. |
| `@realitycollective/native-environment` | Adapter for a native app (OpenXR, visionOS) that embeds a JavaScript engine and owns rendering and audio itself. Forwards to `globalThis.__rcHost`'s `environment`, `audio` and `sensing` slices as plain data - no asset decoding here. |

> [!NOTE]
> Pending is a BabylonJS shim to mirror the capabilities of the Service Framework. It waits on a review across all five families rather than being started here.

### What the core gives you

- **An environment as one document** - sky (vertical gradient, flat colour or an authored equirect image), fog (linear or exponential), an ambient light, a key light and an environment map for image-based lighting. Plain data: serialisable, diffable, comparable.
- **Presets and transitions** - name an environment, then ease to it. Every slot moves together on one curve because they are one document, not five things that happen to be animated at once.
- **Partial specs** - an omitted slot inherits, an explicit `null` turns the slot off. A "storm" preset can carry only the sky and fog it cares about and layer onto whatever lighting is already there.
- **One owner for the background** - "who last wrote `scene.background`" is a race the moment two features care about the sky. Here there is exactly one writer, and passthrough is a **suppression** on top of it rather than a second writer: the app keeps describing the sky it wants, the sky stops being drawn while the real world is showing, and it comes back unchanged afterwards. Nothing has to remember what to restore.
- **Audio the app can mix** - a cue registry, bus and master gains with mute kept separate from level, a retrigger policy per cue (`overlap` / `restart` / `ignore`) and a minimum retrigger interval. The adapter is handed an absolute gain and has no mixing decisions left to make, so a cue sounds the same on every engine. A caller's requested gain is **relative** to that mix, never over it.
- **Image-based lighting as a slot, not an afterthought** - a gradient, an image, or the host's own room probe. Without it a physically-based material has nothing to reflect: every host keeps the sky and the environment map as two separate facilities, and owning one and not the other is owning half of the lighting.
- **Sensor-backed features that admit when they do nothing** - real-world depth occlusion and WebXR light estimation are asked for through the director and REPORT back: `unsupported`, `unavailable`, `pending` or `active`, each with a sentence saying why. Both of them fail to a scene that looks completely normal, so an app that could not tell the difference would ship the failure.
- **The room's own light, as a layer** - `setLightEstimation(true)` lets the host's measurement take over the ambient, key and environment-map slots while it is measuring. The app keeps describing the environment it wants underneath, and turning estimation off hands the slots straight back with nothing to remember.
- **Passthrough that knows which kind it is** - `setPassthrough` takes the WebXR blend mode as well as a boolean, because `additive` displays ADD what you draw to the real world (black is invisible) while `alpha-blend` composites normally. An app can suppress different slots per mode instead of picking one compromise for both.
- **Audio that carries its own distance** - a cue says how far it falls off (reference distance, rolloff, maximum distance, curve) rather than every sound in the title sharing one number set by the adapter.
- **The room, as a separate component** - `WorldSensingDirector` sits beside the environment one and answers a different question: what is actually here. Planes, meshes, anchors and hit tests arrive as plain data with the host's own semantic labels, and the director diffs them so an app is told what appeared, moved and went away rather than re-reading a list every frame. It reports geometry and creates none.
- **No loop of its own** - `update(deltaMs)` is called by whatever already runs per frame. That is what makes an eight-second dusk a five-line unit test instead of a stopwatch and a headset, and it is why an XR host that only ticks while focused gets the pausing behaviour it expects for free.

### What each adapter adds

- **three.js** - a gradient sky as a two-pixel-wide equirectangular `DataTexture`, generated by a pure function (no shader, no canvas, headlessly testable) and regenerated in place across a transition rather than reallocated every frame. `Fog` / `FogExp2` mutated while the kind holds, and an `AmbientLight` and a `DirectionalLight` positioned from the direction light travels. Audio over `Audio` / `PositionalAudio`, where a play arriving before its buffer has decoded is **held** rather than dropped - which is why the first press of a session is not silent.
- **Meta IWSDK** - IWSDK's own `DomeGradient` and `DomeTexture` on the level root (so IWSDK's environment system still hides the background for passthrough), `IBLGradient` / `IBLTexture` for the environment map (`kind: "room"` is native here), its light components on transform entities, and `AudioSource` with one entity per voice so the core's retrigger policy is the one that applies. Depth occlusion drives `DepthSensingSystem` and the per-entity `DepthOccludable`; because IWSDK opts entities in one at a time, the app says which entities those are and the adapter never removes a component it did not add. IWSDK 0.5.3 has no light estimation, and the adapter says so rather than going quiet. Fog is the exception, set on `world.scene`, because IWSDK has no fog component. Setup is one call: `registerEnvironment(world)`.
- **Google XR Blocks** - the three.js adapter plus two sensors. Occlusion registers as a client of XR Blocks' `Depth` manager and chooses its blur; light estimation reads the `Lighting` manager, which already owns the WebXR half. Both are configured during XR Blocks' own init, so anything this adapter arrived too late to change is named in the report rather than silently dropped - including the warning that XR Blocks may be lighting the scene itself, which would light the room twice.
- **Native (OpenXR, visionOS)** - forwards every slot to `globalThis.__rcHost.environment` / `.audio` / `.sensing` as plain data and decides nothing: occlusion, light estimation and world sensing are grown on the port only when the host implements them, so `unsupported` is reported by the same mechanism every other adapter uses, one layer up. A `src` string is resolved and decoded entirely by the native app; nothing here fetches a byte.

No adapter creates geometry.

### Which adapter has which sensor

| | three.js | Meta IWSDK | Google XR Blocks | Native |
| --- | --- | --- | --- | --- |
| Sky, fog, ambient, key | yes | yes | yes | yes |
| Image-based lighting | yes (`room` is a neutral ramp without a prefilter) | yes (`room` is native) | yes | yes, entirely the host's |
| Depth occlusion | yes, three.js's own, gpu-optimized depth only | yes, per entity | yes, XR Blocks' occlusion pass | depends on the host: reported when it has no `applyOcclusion` |
| Light estimation | yes, straight from WebXR | no - reported, and requested upstream | yes, via XR Blocks' `Lighting` | depends on the host: reported when it has no `applyLightEstimation` |
| Spatial attenuation per cue | yes | yes | yes (three.js audio) | yes, passed through as data |
| Planes and meshes | yes, from the `XRFrame` | yes, from scene understanding | yes, from its own detectors | depends on the host's `sensing` slice |
| Anchors | yes | yes | no - XR Blocks exposes none to read | depends on the host's `sensing` slice |
| Hit test | yes, cast from the viewer or from either hand's own ray, with a distance | yes, via `EnvironmentRaycastTarget`; no distance, because IWSDK keeps the ray | no - it places objects rather than reporting | depends on the host's `sensing` slice |
| Measured reflections | yes, given a `reflection` hook to reach the cube map | no - reported | no - reported | depends on the host |

### Asking what a host can do

There is no capability list to read before you start, on purpose: what a host can do depends on the session the app asked for, and a list assembled in advance would be a guess. The pattern is **ask, then read the report**, and it is the same for every feature:

```ts
world.startHitTest({ id: "pointer", space: "right" });
world.getSensing("hitTest");   // unsupported | unavailable | pending | active, with a reason

world.onSensing((report) => {
  if (report.feature === "hitTest" && report.state === "active") showPlacementUI();
});
```

Detection answers immediately - `setDetection` reports before it returns. Hit testing and light estimation answer on a later frame, because both ask the runtime for something, so subscribe rather than checking once. Everything a host cannot do is a report with a sentence saying which option was not set or which feature the session did not enable; nothing fails silently.

## Demo

`demos/playground` - a standalone three.js/WebXR scene with preset transitions, a passthrough toggle that shows the suppression restoring the environment exactly, and live bus/master sliders moving voices that are already sounding. It also builds its own floor and its own objects in a handful of lines, and binds a DOM click to `audio.play` - because both of those are the app's job, and showing that is part of the demo.

```bash
cd WebXR-Environment
npm ci
npm run dev:playground     # http://localhost:8083 - VR button for headsets
```

No audio file ships with the repository; the demo points at `public/audio/hum.mp3` and logs one warning if it is absent, which is what a missing sound should do.

### Live

Deployed from `main` by `ci.yml`; pull requests deploy to the isolated `-test` project instead, so a PR can never touch production.

| | URL |
| --- | --- |
| **Production** | [`webxr-environment.pages.dev`](https://webxr-environment.pages.dev) |
| **Staging (per PR)** | `webxr-environment-test.pages.dev` |

Open it on a headset - each production deploy prints the URL and a QR code to the workflow's step summary.

## Commands

| Command | What |
| --- | --- |
| `npm ci` | set up the workspace |
| `npm test` | vitest - architecture gates, director logic and both adapters, with coverage gates |
| `npm run typecheck` | strict typecheck, all packages + the playground |
| `npm run build` | `tsc` → `dist/` per package |
| `npm run verify:pack` | pack, install into a clean project and import - the consumer path |
| `npm run build:demos` | static Vite build of the playground |
| `npm run dev:playground` | run the playground demo |

## Repository layout

The repository root **is** the npm workspace root - `packages/*` are the publishable libraries, `demos/*` the clients. This matches [WebXR-Input](https://github.com/realitycollective/WebXR-Input), [WebXR-Interactions](https://github.com/realitycollective/WebXR-Interactions), [WebXR-UIExtensions](https://github.com/realitycollective/WebXR-UIExtensions) and the [service-framework](https://github.com/realitycollective/com.realitycollective.service-framework.ts).

## Layering rule

```
app → ONE adapter (threejs | iwsdk | xrblocks) → core (webxr-environment) → nothing
```

The XR Blocks adapter is the one exception to "one arrow": it builds on the three.js adapter, because XR Blocks renders through three.js and reimplementing four slots would only let them drift. Adapters inside ONE repository may compose like that; between families nothing references anything, which is the rule that matters.

Arrows only point down, and the core's arrow points at nothing at all. Its architecture test fails the moment an engine import lands in it - or an import of the service framework, or of the input contracts, or a read of `navigator.xr`.

## Where the boundary is

The stack already has three families, and this one is drawn so as not to overlap any of them:

| Family | Owns |
| --- | --- |
| [service-framework](https://github.com/realitycollective/com.realitycollective.service-framework.ts) | Dependency injection, the runtime adapter, the session and the capabilities derived from it |
| [WebXR-Input](https://github.com/realitycollective/WebXR-Input) | Input contracts |
| [WebXR-UIExtensions](https://github.com/realitycollective/WebXR-UIExtensions) | UI, layout, panels, UX input |
| [WebXR-Interactions](https://github.com/realitycollective/WebXR-Interactions) | Interactivity, behaviours, stations, feedback **intents** |
| **WebXR-Environment** | The setting: sky, fog, light - and the **playback** of sound |

**Packages in this estate do not reference one another.** There is no dependency between WebXR-Environment and any sibling - not a runtime import, not a type-only import, not a copied signature in a test. What crosses a boundary crosses it as a subscription the **app** makes, at the one place where both halves are already in scope:

```ts
// The client owns this line. Both packages are inert without it.
const stop = interactions.runtime.onEvent((event) => {
  if (event.kind === "press") audio.play("click");
});
```

If a source is there, the app binds it. If it is not, nothing happens, and neither package notices. That is what "decoupled" has to mean to survive: the moment one package knows the shape of another, the estate is a graph again.

Two consequences worth stating outright:

- **Passthrough is not read here.** Whether the real world is showing is a property of the session, and the session is the service framework's. This package takes a boolean through `setPassthrough`, pushed in by the app. That is the whole of the relationship, and it is why the core can have no dependencies at all.
- **Nothing here decides that a sound should happen.** `play(cueId, options?)` is the entire inbound surface. There is no feedback adapter, no intent type, no cue-map helper - those would all be this package holding an opinion about another one.

**Portable world-building is still not a promise, and content is never the framework's.** Meshes, prefabs, placement, floors and art direction are built by the app, as recorded in the [WebXR-Interactions README](https://github.com/realitycollective/WebXR-Interactions#what-this-stack-is-and-is-not). The stock presets shipped here are examples to copy in the first five minutes of a project, not a view on how anyone's world should look.

The boundary in full, including what is deliberately unowned and where an earlier draft drew it wrongly, is in [`docs/BOUNDARY.md`](docs/BOUNDARY.md). Gaps that turned out to belong to the **other** packages are recorded in [`docs/UPSTREAM_ENHANCEMENTS.md`](docs/UPSTREAM_ENHANCEMENTS.md) rather than being absorbed here.

## Automation (`.github/workflows/`)

Two workflows ship in every Reality Collective TypeScript repository, with the same names everywhere. `ci.yml` both gates and deploys: the build job runs once and the deploy jobs consume its artifacts, so nothing is built or tested twice.

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | every PR + push to `main` / `development` | Build, typecheck, test with coverage gates, `verify:pack`, playground build. On a PR it then deploys to `webxr-environment-test`; on a push to `main`, to production. The deploy steps skip when the Cloudflare secrets are absent, leaving a pure build gate. After a merged PR passes, it queues a publish dry run on the branch the PR merged into |
| `publish-npm.yml` | manual dispatch, plus the dry run CI queues after a merged PR | packs all three packages and publishes to **npmjs.com** with provenance - `preview` dist-tag from `development`, `latest` from `main`. **Defaults to a dry run** |

## Releasing

Work branches off `main`; PRs target `main`. Releases are cut by dispatching the **Publish to npm** workflow, which defaults to a dry run:

| Dispatched from | dist-tag | Then |
| --- | --- | --- |
| `development` | `preview` | bumps the preview counter and pushes it back |
| `main` | `latest` | tags, cuts the GitHub release, re-seeds `development` at the next patch preview |

Unlike the sibling repositories, nothing here depends on `@realitycollective/webxr-input`, so there is no cross-repository publish order to observe.

## What this stack is and is not

The Reality Collective WebXR packages aim at one outcome: an app's logic, input handling, interactions and UI should not care which engine hosts them. Each family ships an engine-free core and thin adapters for Meta IWSDK, plain three.js and WebXR, and where the family has one, Babylon.js and Google XR Blocks. When an app still has to reach into the host, either a contract is missing, which is a bug to report, or the app is overreaching.

Portable world-building is not a current promise. Scene content (meshes, prefabs, placement) is built by the app, ideally behind a factory interface the app owns, so that a second host can implement the same factories. A shared content descriptor, following the shape of the UI family's `SceneDescriptor`, will be considered only when a second host is actually targeted. Meta's `iwsdk.scene.v1` format is an acceptable authoring interchange in the meantime.

That applies here with no exception. This family describes the sky, the fog and the light, which every host exposes and exposes differently. It creates no geometry, and the presets it ships are examples to copy rather than art direction.

Position recorded on 2026-09-03 from the Pale Signal client's gaps report.

## Licence

MIT.
