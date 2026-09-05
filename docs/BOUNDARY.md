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

**Out of scope, and why.**

| Turned down | Why | Whose |
| --- | --- | --- |
| Reading the session to discover passthrough | The session is the platform layer's. Taking a boolean through `setPassthrough` is what lets the core have **zero** dependencies | service-framework |
| Any notion of an input source, hand or controller | Nothing in an environment needs one | WebXR-Input |
| Panels, layout, dock modes, in-world settings UI for the mix | A volume slider is a UI control that happens to call `setBusGain` | WebXR-UIExtensions |
| Interactables, behaviours, gaze, feedback **intents** | Interactions decides a sound *should* happen; this decides what it sounds like | WebXR-Interactions |
| Any geometry at all - meshes, prefabs, placement, floors | Content. An app builds a floor from a geometry and a material; no platform facility is involved (see the ground-plane correction below) | the app |
| Art direction | Content. The stock presets are examples to copy, not a view on how a world should look | the app |
| Scene composition and asset loading | Explicitly not a promise of this stack (see Deliberately unowned) | nobody, deliberately |
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

---

---

## Deliberately unowned

Recorded so that the absence is visibly a decision:

- **Scene composition / content descriptors.** The WebXR-Interactions README (position recorded 2026-09-03) states that portable world-building is not a current promise and that a shared content descriptor will be considered only when a second host is actually targeted. Nothing here changes that.
- **Asset loading.** Cue `src` and any future texture reference are strings the adapter resolves. IWSDK has `AssetManager`; three.js has loaders; a portable asset layer is a fifth family, not a corner of this one.
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
