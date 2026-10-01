# Where the boundary is

The permanent record of what this repository owns, what it deliberately does not, and where an earlier draft drew the line wrongly. Written while the package was built, feature by feature, by deciding whether each thing belonged here or in one of the four families that already existed.

The requests that turned out to be somebody else's are in [`UPSTREAM_ENHANCEMENTS.md`](UPSTREAM_ENHANCEMENTS.md) beside this file.

**Verified against:** `@realitycollective/service-framework` 1.0.1-preview.2, `@realitycollective/webxr-interactions` and `@realitycollective/iwsdk-interactions` 0.1.0-preview.2/.3, `@realitycollective/webxr-uiextensions` and `@realitycollective/iwsdk-uiextensions` 0.1.0-preview.2, `@realitycollective/webxr-input` 0.1.1, `@iwsdk/core` 0.5.3. Every claim below was read out of the shipped package, not inferred from a changelog.

---

## How the boundary was drawn

The four existing families own:

| Family | Owns |
| --- | --- |
| service-framework | DI, the runtime adapter, the session, capabilities derived from it |
| WebXR-Input | Input contracts |
| WebXR-UIExtensions | UI, layout, panels, UX input |
| WebXR-Interactions | Interactivity, behaviours, stations, feedback **intents** |

What was left over from the client's gaps report was **G4 (environment)** and **G5 (audio playback)**. That is what this repository took, and nothing else. Concretely:

**The rule the boundary follows,** as set by the maintainers:

> The cross-platform packages provide integration with app-level interfaces or requirements, to simplify the use of **platform features** depending on which headset the title runs on, serviced by the active shim. The client runs the app and provides content and direction.

So the test for anything proposed here is: *is this a facility the host exposes, which differs per host?* Not: *is this something an environment usually has?*

**In scope.** Sky, fog, ambient and key lighting - `scene.background` / `scene.fog` / `AmbientLight` on three.js, `DomeGradient` / `AmbientLightComponent` on IWSDK - plus transitions between named presets and passthrough suppression of the first two. Audio: a cue registry, bus and master mix, retrigger policy, throttling and voice lifetime, over `Audio` / `PositionalAudio` or `AudioSource`.

**Scene management (owner's decision, 2026-09-25).** A scene list, single and additive loading, unloading any scene in the stack, preloading, an active scene whose `environment` drives the director, persistent nodes and lifecycle events. It passes the test above: every host changes scenes, and each does it differently (IWSDK levels and `persistent` entities, three.js object graphs a host builds and disposes, a native app's own loaders with no engine in JavaScript at all), while the meaning is the same everywhere. The rules live in `SceneManager`; each host implements `ScenePort`, which builds and destroys content with the host's own loaders. A `src` means the same thing on every host.

**Out of scope, and why.**

| Turned down | Why | Whose |
| --- | --- | --- |
| Reading the session to discover passthrough | The session is the platform layer's. Taking a boolean through `setPassthrough` is what lets the core have **zero** dependencies | service-framework |
| Any notion of an input source, hand or controller | Nothing in an environment needs one | WebXR-Input |
| Panels, layout, dock modes, in-world settings UI for the mix | A volume slider is a UI control that happens to call `setBusGain` | WebXR-UIExtensions |
| Interactables, behaviours, gaze, feedback **intents** | Interactions decides a sound *should* happen; this decides what it sounds like | WebXR-Interactions |
| Any geometry at all - meshes, prefabs, placement, floors | Content. An app builds a floor from a geometry and a material; no platform facility is involved (see the ground-plane correction below) | the app |
| Art direction | Content. The stock presets are examples to copy, not a view on how a world should look | the app |
| Scene composition, asset decoding and converting scene formats between hosts | A `src` is resolved by the host's own loaders. What a scene contains, and turning one host's format into another's, is the app's asset pipeline (see Deliberately unowned) | the app |
| Physics | Already recorded as the client's, surfaced by Interactions only as the `grabs: "native"` capability | nobody, deliberately |

The core's architecture test enforces the first four: it fails on an engine import, an import of `@realitycollective/service-framework`, an import of `@realitycollective/webxr-input`, a read of `navigator.xr`, or any runtime dependency whatsoever.

**And no package here references a sibling in any form** - not a runtime import, not a type-only import, not a copied signature in a test. What crosses a boundary crosses it as a subscription the **app** makes:

```ts
// The client owns this line. Both packages are inert without it.
const stop = interactions.runtime.onEvent((event) => {
  if (event.kind === "press") audio.play("click");
});
```

If a source is there, the app binds it. If it is not, nothing happens and neither package notices.

## The second seam: sensing (added 2026-09-07)

The package began write-only, and said so: presets in, port calls out, no reporting mechanism, by design. That was right while every slot was a decision the app had already made, because the app can SEE a sky.

It stops being right the moment a feature is backed by a sensor. Depth occlusion is granted or refused by the session; light estimation starts and stops as the runtime gains and loses confidence; and both fail to a scene that looks completely normal. "Occlusion is on and doing nothing" and "occlusion is working, and nothing is in front of you" are the same picture.

So there is now exactly one inbound path - `EnvironmentPort.observe(host)` - carrying two kinds of message: a REPORT (`unsupported` / `unavailable` / `pending` / `active`, plus a sentence for a human), and an ESTIMATE (measured lighting, in the same spec types the app already writes). The rule that keeps it from becoming a back door: **a report never changes what the app asked for; it changes what the app can be told.** The estimate is the single exception and an explicit one, opted into with `setLightEstimation` and layered over the light slots the way passthrough is layered over the sky.

**What passed the boundary test, and why.** Each of these is a facility the host exposes, which differs per host - the same test as sky and fog:

| Capability | three.js | Meta IWSDK | Google XR Blocks |
| --- | --- | --- | --- |
| Image-based lighting | `scene.environment` + intensity + rotation | `IBLGradient` / `IBLTexture`, including a native `"room"` | inherited from three.js |
| Authored sky texture | equirect `scene.background` + blur | `DomeTexture` | inherited from three.js |
| Depth occlusion | built into the renderer since r158, gpu-optimized only | `DepthSensingSystem` + per-entity `DepthOccludable`, three shader modes | its own `Depth` manager and occlusion pass, plus the WebXR session preferences the other two hide |
| Light estimation | `XREstimatedLight` | none at all | its `Lighting` module, over the same three.js class |
| Spatial attenuation per cue | `PositionalAudio` | `AudioSource` with a `DistanceModel` | three.js audio |

Three of those differ so sharply that a contract built from the thinnest one would have made the other two worse, which is why `OcclusionSpec` takes its modes from IWSDK and its session preferences from XR Blocks, and why the sky gradient gained an optional horizon stop: IWSDK's dome has always been a three-stop ramp, and the adapter was inventing the middle colour because the contract could not carry one.

**What was turned down, and why.**

| Turned down | Why | Whose |
| --- | --- | --- |
| A body solved from the head and hands (embodiment) | No host exposes a body. The tracked poses are the host facility and they are WebXR-Input's contract; the solver is pure trigonometry, and the meshes it drives are content. Housing it here would repeat the `GroundSpec` mistake below, with a better disguise | the app, or a package named for what it is |
| XR Blocks' depth MESH - colliders, hole patching, shadow receiving, downsampled geometry | A mesh with colliders is geometry and physics, both already outside this repository. The sensing knobs beside it - usage, format, update rate - were taken; the mesh was not | the app |
| XR Blocks' segmentation, humans and faces | Perception features that produce content, not an environment the app describes | the app |
| Reflection cube maps from `XRWebGLBinding` | Needs a live GL context and a prefilter pass, which is a renderer's job. The port reports that the `ibl` part of an estimate was not measured rather than inventing one | the app's renderer |
| Requesting `depth-sensing` on the session | Unchanged from the original rule: the session is the platform layer's. Recorded upstream as item 2.5, because the feature needs an init dictionary a feature string cannot express | service-framework |

**Planes, meshes, anchors and hit test are a SEPARATE COMPONENT, not slots.** They are real platform sensing and they differ per host, but none of them feeds the environment: they feed placement, locomotion, physics and interaction. So `WorldSensingDirector` sits beside `EnvironmentDirector` with its own port, its own registries and no reference to `EnvironmentSpec` in either direction. The two share exactly one thing, the vocabulary their reports are written in, so a single readout can cover everything a host was asked for.

The rule that keeps it inside the boundary is the same one as everywhere else: **it reports geometry, it does not make any.** A plane arrives as a pose, a size and the host's own semantic label; a mesh's vertices are the runtime's buffers passed through by reference, never copied and never mutated. Nothing here builds a `Mesh`, a collider, a material or a debug visualisation, and what an app does with a table it has been told about is the app's, exactly as a floor always was.

Three hosts, three different amounts of help, all of it reported honestly:

| | three.js and raw WebXR | Meta IWSDK | Google XR Blocks |
| --- | --- | --- | --- |
| Planes | read from the `XRFrame` | entities carrying `XRPlane` | `PlaneDetector`, already three.js objects |
| Meshes | `XRMesh` buffers, measured once per change | `XRMesh` component, IWSDK measured it already | `MeshDetector`, measured from the geometry |
| Anchors | `frame.createAnchor` and `trackedAnchors` | an entity with `XRAnchor` on it | **none** - XR Blocks places objects for you and exposes nothing to read |
| Hit test | `requestHitTestSource` | `EnvironmentRaycastTarget` on an entity | **none** - `placeOnSurface` moves an object rather than answering |

What still belongs to somebody else: requesting `plane-detection`, `mesh-detection`, `anchors` or `hit-test` on the session (the platform layer's, as ever), turning a detected plane into a floor an avatar can walk on (physics, the app's), and deciding what to spawn on a table (content, the app's).

**Generalise the parameters, pass through the vocabulary.** Where two hosts do the same thing with different spellings, the contract carries it in ITS OWN terms and each adapter converts - that is what the abstraction is for, and losing a capability because the spellings differ would make this package the thing removing it. Directional audio is the worked example: angles are radians here because every other angle here is, both adapters convert to the degrees their host wants, and neither the app nor the contract mentions a panner.

That rule governs the parameters OF a capability. It deliberately does not govern open-ended vocabularies: semantic labels stay the host's own strings, because mapping them to a closed set would lose a label every time a runtime adds one, which is degradation pointing the other way. And where a host lacks the MECHANISM rather than the spelling - three.js occludes everything or nothing, IWSDK occludes per entity - no naming bridges it, so the contract expresses the richer form and reports what could not be honoured. Never the intersection, never silence.

**A measured reflection is a marker, not a value.** Light estimation produces three things, and two of them - a spherical-harmonic probe and a primary light - convert cleanly into the plain data this package trades in. The third, a reflection cube map, does not: it is a live texture on a GPU that the runtime keeps replacing. Rather than pretend a texture is a value, or drop the capability, `IblSpec` gained `{ kind: "estimated" }`: the app says "use what you measured", the adapter that measured it applies it, and the document stays plain data with one honest hole in it. An adapter that measures nothing reports `unsupported` and leaves the app's own environment map alone.

**Adapters inside this repository may build on each other.** `xrblocks-environment` extends `threejs-environment`, because XR Blocks renders through three.js and reimplementing four slots would only let them drift - exactly as `xrblocks-interactions` builds on `threejs-interactions`. The no-references rule is between FAMILIES, and it is unchanged: nothing here imports, types against, or tests against a sibling repository.

---

---

## Deliberately unowned

Recorded so that the absence is visibly a decision:

- **Scene composition / content descriptors.** The WebXR-Interactions README (position recorded 2026-09-03) states that portable world-building is not a current promise and that a shared content descriptor will be considered only when a second host is actually targeted. Scene MANAGEMENT moved in on 2026-09-25 (see In scope); what a scene contains did not. The manager loads a `src` and never reads it, and converting a scene format between hosts stays the app's pipeline.
- **Asset loading.** Cue `src`, texture references and scene `src` are strings the adapter resolves. IWSDK has `AssetManager` and `SceneJSONImporter`; three.js has loaders; a native app has its own. A portable asset layer is a separate family, not a corner of this one.
- **How a scene looks.** Materials, opacity, animation and effects are presentation the app builds per host. It is where a native host is meant to exceed the web.
- **Physics.**
- **WebXR composition layers** (`XRQuadLayer` and friends). A media layer is arguably environment, but it is also a rendering-pipeline concern that neither adapter's host currently exposes portably. Not taken.

---

---

## Where an earlier draft got the boundary wrong

Two corrections, from the maintainers, applied before this was published. Recorded rather than quietly fixed, because both are the kind of mistake that comes back.

### 1. `GroundSpec` - removed

The first draft described a parametric ground plane (a colour, a size, an opacity) and both adapters built a `PlaneGeometry` for it. The argument was that an environment without a floor is not an environment.

**That argument is wrong on the stated rule.** A ground plane is not a platform facility - no host exposes one, and no shim is needed to reach it. It is a mesh and a material, which is content, which is the app's. "An environment usually has one" is not the test; "the host exposes this and each host exposes it differently" is.

`GroundSpec`, `applyGround` and both implementations are gone. The playground demo builds its own floor in four lines, which is where that code belongs and is now part of what the demo demonstrates.

### 2. The audio seam - no seam

The first draft described `AudioDirector` as "structurally satisfying" the interaction core's `FeedbackAudioSink`, and carried a test asserting it.

Nothing depended on anything in either direction, so the *dependency* was already correct - but the framing and the test were not. Designing this package's signature against another package's, and pinning that in a test, is coupling by another name: it makes a sibling's API a thing this repository must track, and it invites the next person to add the "obvious" convenience adapter that would make it a real dependency.

The rule is simpler than the seam was. **This package plays a sound when asked. The client binds whatever it has to `play(cueId)`.** No intent type, no cue-map helper, no feedback adapter, no test naming a sibling. If a source is present the app binds it; if it is not, nothing happens.
