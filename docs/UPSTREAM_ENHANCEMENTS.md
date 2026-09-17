# Upstream enhancements

Requests that belong to one of the four sibling families rather than here. Recorded as enhancement requests rather than absorbed into this repository, which is the point: none of them is a request for another package to know about this one, and none would be satisfied by a dependency in either direction.

For what this repository DOES own, and why, see [`BOUNDARY.md`](BOUNDARY.md).

Section numbers are kept from the original report, so the gaps at 1, 5 and 6 are the boundary sections that moved to that file. Item ids such as 2.1 and 3.1 are quoted in the sibling repositories' issues and changelogs, so they do not get renumbered.

**Verified against:** `@realitycollective/service-framework` 1.0.1-preview.2, `@realitycollective/webxr-interactions` and `@realitycollective/iwsdk-interactions` 0.1.0-preview.2/.3, `@realitycollective/webxr-uiextensions` and `@realitycollective/iwsdk-uiextensions` 0.1.0-preview.2, `@realitycollective/webxr-input` 0.1.1, `@iwsdk/core` 0.5.3. Every claim below was read out of the shipped package, not inferred from a changelog.

**Status.** Every item below was verified against the sibling working trees on 2026-09-04 and accepted, with two corrections noted inline. Item 4.1 was withdrawn: the handover it refers to had already been revised, and the client was reading an older copy. Item 3.1 turned out to be the whole `webxr-input` 0.1.1 switch-over rather than a single missing line, and item 3.1b needs a weaker converse than first proposed, because the three.js provider reports `presence: false` until the app registers a visual.

---

## 2. service-framework

### 2.1 `AdapterCapabilities.passthrough` collapses `environmentBlendMode` to a boolean - **enhancement**

`deriveCapabilities` reads `session.environmentBlendMode` and reduces it to `passthrough: blendMode !== "opaque"`. The string itself is never surfaced:

```ts
export interface AdapterCapabilities {
  readonly immersive: boolean;
  readonly handTracking: boolean;
  readonly planeDetection: boolean;
  readonly passthrough: boolean;
}
```

That is the right flag for "should I draw a sky", which is all this package needs today. It is **not** enough to choose *how* to draw everything else, because the two passthrough blend modes behave oppositely:

- `alpha-blend` (Quest video passthrough) composites normally - black is black.
- `additive` (see-through optical displays) adds the rendered image to the world - **black is fully transparent**, and a dark fog or a dark fallback sky is simply invisible.

An environment that wants to dim the world on an additive display has to do the opposite of what it does on an alpha-blend one. Today it cannot tell them apart.

**Request:** surface the raw mode, e.g. `readonly environmentBlendMode: "opaque" | "alpha-blend" | "additive" | null`, alongside the existing boolean. Purely additive; `passthrough` keeps its meaning.

**Impact if not done:** additive displays get a fallback tuned for video passthrough. No current target is additive, so this is a correctness-in-advance request, not a live defect.

### 2.2 The IWSDK binding does not bind `inputsourceschange` - **parity gap**

The three.js and Babylon bindings re-derive capabilities when the session's input sources change; the IWSDK one does not. An app on IWSDK that wants `handTracking` to update when the player puts the controllers down has to attach the listener itself and call `adapter.refreshCapabilities()`.

**Honest impact:** low. `handTracking` has no reader in the client this came from, and the interaction provider binds that event for its own purposes, so presence is correct either way. This is an inconsistency between bindings rather than a bug anyone is hitting - but it is the kind of inconsistency that makes the next person's workaround permanent.

**Request:** bind it in the IWSDK binding, so all three behave the same and the client-side listener can be deleted.

### 2.3 `SessionRequestOptions` carries no per-request features - **enhancement**

```ts
export interface SessionRequestOptions {
  readonly timeoutMs?: number;
}
```

The facet cannot express `requiredFeatures` / `optionalFeatures`, so an app that swaps from `immersive-vr` to `immersive-ar` mid-session gets whatever the host's defaults are for the new mode. On IWSDK that means `world.xrDefaults`, which was configured for the *original* mode.

**Request:** optional `requiredFeatures?: readonly string[]` and `optionalFeatures?: readonly string[]`, merged by the binding over its host defaults.

**Impact:** a mode swap cannot ask for what it needs. Workable today only because the defaults happen to be adequate.

### 2.4 `EnvironmentDescriptor` is a naming collision - **documentation**

service-framework exports `EnvironmentDescriptor` / `createBrowserEnvironment()`, meaning the *platform* environment (a name plus a set of capability strings). This repository's `EnvironmentSpec` means the *visual* environment. Same word, unrelated concepts, and an app can hold both.

**Request:** a sentence in each package's README naming the other, so nobody spends an afternoon on it. Renaming either is not worth a breaking change.

### 2.5 A session cannot ask for the depth sensing it is going to use - **enhancement**

`SessionRequestOptions` now carries `requiredFeatures` and `optionalFeatures` (item 2.3, shipped), which is enough to ask for `depth-sensing`. It is not enough to ask for depth sensing that is USABLE.

WebXR's depth-sensing feature takes a whole init dictionary of its own, not just a feature string:

```ts
navigator.xr.requestSession("immersive-ar", {
  requiredFeatures: ["depth-sensing"],
  depthSensing: {
    usagePreference: ["gpu-optimized"],
    dataFormatPreference: ["float32", "luminance-alpha"],
    depthTypeRequest: ["raw"],       // added to the draft in 2026
    matchDepthView: true,
  },
});
```

That matters here because three.js's built-in occlusion runs ONLY when `session.depthUsage === "gpu-optimized"`. A session that asked for `depth-sensing` and got the cpu-optimized form is a session where occlusion silently does nothing, and there is no way to re-request it without ending the session.

**Request:** an optional pass-through for feature init dictionaries on `SessionRequestOptions` - the whole `XRSessionInit` extras rather than a depth-specific field, so `domOverlay`, `hitTestOptions` and whatever comes next need no further changes.

**Impact if not done:** an app on this stack asks for depth through the platform layer and then cannot say which kind, so `OcclusionSpec.source` is a preference the adapter can only report as ignored. WebXR-Environment reports it rather than hiding it, which is the workaround, not a fix.

## 3. WebXR-Interactions

### 3.1 The IWSDK provider never sets `capabilities.presence` - **defect**

`supportsPresence` is `true` on the IWSDK provider and `setPresenceVisible` / `setPresenceModality` both work. But `refreshCapabilities()` builds its capability object from `NO_CAPABILITIES` plus `rays`, `pokes`, `grabs`, `handJoints`, `pinch`, `buttonsAxes`, `gaze`, `headPose` and `haptics` - **`presence` is never among them**. The provider's own source says as much: the `supportsPresence` field is commented "Becomes `capabilities.presence` at `@realitycollective/webxr-input` 0.1.1", and that version is released and installed, so the follow-up simply has not happened.

An app following the contract reads `capabilities.presence`, sees `false`, and hides a feature that works. The workaround is to read `provider.supportsPresence` directly - which is what the client does, with a standing note in its `CLAUDE.md` saying why.

**Request:** set the capability from the provider, and delete the workaround from the sample.

**And the contract cannot catch it.** `inputProviderContractCases()` (shipped from webxr-input 0.1.1) has a presence case, but it asserts only the *forward* implication:

> `capabilities.presence` is true, so `setPresenceVisible()` must be implemented

A provider that implements both methods and declares nothing passes. **Second request:** add the converse case - a provider implementing `setPresenceVisible` / `setPresenceModality` must declare `capabilities.presence` - so this class of drift fails a test instead of a headset.

### 3.2 Presence is re-applied without diffing - **efficiency**

`setPresenceVisible(target, visible)` walks and re-applies whether or not the value changed. An app pushing presence from a state subscription (the documented pattern) therefore re-applies on every unrelated state change.

**Request:** hold the last applied value per target and return early when it is unchanged. Cheap, and it makes the documented pattern free.

### 3.3 `registerVisual` exists only on the three.js adapter - **documentation, not a defect**

It is asymmetric for a good reason: on three.js the app builds its own hand and controller models, so presence has to be told what to hide; IWSDK and Babylon build their own. Worth one line in the adapter table saying so, because the asymmetry currently reads as an omission.

### 3.4 `routeAudioToSink` - **no request, and none should be made**

An earlier draft of this repository raised a per-cue gain for `routeAudioToSink`'s cue map, and pinned the sink's shape from this side with a test that reproduced `FeedbackAudioSink`, `FeedbackIntent` and `routeAudioToSink` verbatim.

**Both were wrong and both are gone.** The gain request was unnecessary - `AudioCue.gain` already trims per cue and the two multiply, so an intent asks for a relative loudness and the app's mix still applies over it. The test was worse: a verbatim copy of a sibling's signatures is a dependency written in a form the compiler cannot see, and it created a standing obligation to track another package's API. The estate is decoupled precisely so that neither of those exists.

What replaced it, in `packages/webxr-environment/test/audio-sink.test.ts`, asserts only what this package actually guarantees to *anything* an app might bind: an unknown cue is dropped rather than thrown, and a caller's gain is relative to the mix rather than over it. The event source in that test is an anonymous emitter, because that is exactly how much this package knows about what will drive it.

**Recorded so neither mistake is repeated.**

---

---

## 4. WebXR-UIExtensions

Nothing environmental belongs here and nothing was taken from it. Two items, both documentation:

### 4.1 The handover's HUD example predates the window handle - **documentation**

§3.6 of the adoption handover still shows binding panel content by querying `PanelUI + PanelDocument` and reaching into `UIKitDocument`. The shipped API is `panel.getElementById(id).setProperties({...})` off the handle returned by `createSceneHost(world).createWindow(...)`. The stale example is the one a reader copies.

### 4.2 `runtimeAdapterContract` and `windowHostContract` are named but not shipped - **scope**

Both are referred to in the handover as the way a new adapter proves itself. Neither is exported by the packages that would own them.

This is not a hypothetical ask: **WebXR-Input already does it.** `@realitycollective/webxr-input` 0.1.1 exports `inputProviderContractCases()` - a runner-free array of `{ name, run(provider, driver) }` cases, deliberately shipped as data so each adapter repository hosts them in its own runner in three lines. That is the pattern; it works; the other families have not adopted it.

**Request:** ship the named contracts in the same shape, from service-framework and from webxr-uiextensions respectively. An adapter author currently has no way to prove conformance except by reading the reference adapter - and, as §3.1 shows, a contract suite is also where drift gets caught.

---

---

## 6. Meta IWSDK

Not a sibling family, and not ours to fix - but the two gaps below are the reason two features in this repository read differently on IWSDK than on the other hosts, and both are worth filing upstream.

### 6.1 No light estimation - **feature request**

`@iwsdk/core` 0.5.3 has nothing for WebXR light estimation: no probe request, no session hook, and zero hits for it in the typings. The other two hosts both have it - three.js ships `XREstimatedLight`, and XR Blocks wraps that same class in its `Lighting` module - so an app that lights its content from the real room works everywhere except the host most likely to be running on a passthrough headset.

The IWSDK adapter reports `lightEstimation: unsupported` with that sentence in the detail, so it is visible rather than silent.

**Request:** an estimated-lighting source in IWSDK's lighting module, feeding its existing ambient and directional light components.

### 6.2 Occlusion is per entity, with no global mode - **enhancement**

`DepthSensingSystem` turns depth sensing on, but occlusion applies only to entities carrying `DepthOccludable`, which patches every material under the entity through `onBeforeCompile`. There is no "occlude everything that depth-tests", which is what both other hosts do by writing depth once before the scene draws.

The consequence is in this repository's API: `OcclusionSpec.scope: "all"` needs the app to say which entities it means, because walking a scene graph looking for meshes would be this package guessing at content it does not own.

**Request:** a global occlusion mode on `DepthSensingSystem`, equivalent to a depth prime pass, so `scope: "all"` needs no entity list.

**Impact if not done:** none on correctness. The adapter takes an `occludables` option and says plainly when it has not been given one.

## 7. Summary

| # | Package | Item | Kind |
| --- | --- | --- | --- |
| 2.1 | service-framework | Surface `environmentBlendMode`, not just `passthrough` | Enhancement |
| 2.2 | service-framework | IWSDK binding should bind `inputsourceschange` | Parity gap |
| 2.3 | service-framework | `SessionRequestOptions` needs per-request features | Enhancement |
| 2.4 | service-framework | `EnvironmentDescriptor` naming collision | Documentation |
| 3.1 | WebXR-Interactions | IWSDK provider never sets `capabilities.presence` | Defect |
| 3.2 | WebXR-Interactions | Presence re-applied without diffing | Efficiency |
| 3.3 | WebXR-Interactions | Explain why `registerVisual` is three.js-only | Documentation |
| 4.1 | WebXR-UIExtensions | Handover §3.6 HUD example is stale | Documentation |
| 3.1b | WebXR-Input | Contract case for the converse presence implication | Test coverage |
| 4.2 | service-framework / UIExtensions | Ship the named contracts as webxr-input already does | Scope |
| 2.5 | service-framework | Session request cannot carry feature init dictionaries (`depthSensing`) | Enhancement |
| 6.1 | Meta IWSDK | No WebXR light estimation | Feature request |
| 6.2 | Meta IWSDK | Occlusion is per entity, with no global mode | Enhancement |

Items 6.1 and 6.2 are requests to Meta rather than to a sibling family, and are listed here because they are the reason two capabilities behave differently on IWSDK.

Nothing in this list blocks WebXR-Environment. Every item is either worked around in a way that is documented at the workaround, or has no live impact yet.

None of them is a request for another package to know about this one, and none of them would be satisfied by a dependency in either direction.
