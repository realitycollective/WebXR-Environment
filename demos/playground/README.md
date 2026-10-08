# Environment playground

A standalone three.js and WebXR scene for the environment, world-sensing and audio directors. The repository [README](../../README.md#demo) says what it shows and how to run it: `npm run dev:playground` at the repository root, then http://localhost:8083.

## Service Framework

The playground is a Service Framework app. `src/main.ts` builds a `ServiceManager` and the three.js binding's `WebXRRuntimeAdapter`, which owns the loop through `renderer.setAnimationLoop`. Each frame, the adapter emits `renderTick`, the channel that calls each service's `render()`. The app service, `EnvironmentAppService` in `src/app-service.ts`, imports only the Service Framework core and logs the adapter's capabilities and session state to the console. Its `render()` hands each frame to a closure in `main.ts`, which ticks the environment, world-sensing and audio directors and draws the scene. The three.js `VRButton` still opens the session, and the adapter adopts it from `renderer.xr`.
