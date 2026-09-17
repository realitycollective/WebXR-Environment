# @realitycollective/xrblocks-environment

The **Google XR Blocks adapter** for the Reality Collective WebXR Environment Extensions. EXPERIMENTAL, in the same sense as the other XR Blocks adapters in this estate: it is written against the *shape* of XR Blocks rather than importing it, and XR Blocks is moving quickly.

It re-exports [`@realitycollective/threejs-environment`](https://www.npmjs.com/package/@realitycollective/threejs-environment), which re-exports the engine-free core, so this is the only package you install.

```bash
npm install @realitycollective/xrblocks-environment three
```

## Use

```ts
import {
  createXRBlocksEnvironment,
  DEFAULT_OCCLUSION,
  STOCK_PRESETS,
} from "@realitycollective/xrblocks-environment";

const { director } = createXRBlocksEnvironment(
  xb.core.scene,
  { depth: xb.core.depth, lighting: xb.core.lighting },
  { presets: STOCK_PRESETS, initial: STOCK_PRESETS.noon },
);

director.setPassthrough(true);
director.setOcclusion(DEFAULT_OCCLUSION);   // real-world depth hides your content
director.setLightEstimation(true);          // the real room lights it

// From your XR Blocks Script's own update. Nothing here ticks itself, and on
// this host that matters more than on the others: both sensors are polled here.
director.update(deltaMs);
```

## What the adapter does

- **Sky, fog, lights and image-based lighting** come from the three.js adapter it extends. XR Blocks renders through three.js, so reimplementing four slots would only let them drift.
- **Depth occlusion** - registers as a client of XR Blocks' `Depth` manager (`resumeDepth` / `pauseDepth`), turns its occlusion pass on, and chooses the depth-texture blur from the requested mode and softness.
- **Light estimation** - reads the `Lighting` manager, which already owns the WebXR half, and turns its directional light and ambient probe into the same specs an app writes by hand. The director then lays them over the ambient, key and ibl slots.
- **The room** - `createXRBlocksWorldSensing(xb.core.world)` reads XR Blocks' `PlaneDetector` and `MeshDetector`. Anchors and hit testing report `unsupported`: XR Blocks has `placeOnSurface` and `anchorObjectAtReticle`, which move an object for you and hand nothing back, so neither can answer where a ray would land.

## Two things worth knowing

**XR Blocks is configured before you get here.** Its depth and lighting managers are set up during `xb.init`, so this adapter can start and stop them and cannot conjure an occlusion pass that was never built. Anything it arrives too late to change is named in a sensing report - which option to set, which preference the session was actually requested with - rather than silently dropped. Read them with `director.getSensing("occlusion")` and `director.onSensing(...)`.

**Do not light the room twice.** If XR Blocks' own estimated lights are on (`useAmbientSH`, `useDirectionalLight`), and this package applies the same estimate to the ambient and key slots, you get both. Turn the XR Blocks lights off and let the director own them; the adapter says so in the report if it sees both.

## Peer dependency

`three >= 0.170.0`, plus an XR Blocks build to hand in. `xrblocks` itself is **not** a dependency: the depth and lighting managers are described structurally, so nothing here pins a version of it. Verified against `xrblocks` 0.21.1.

## Licence

MIT.
