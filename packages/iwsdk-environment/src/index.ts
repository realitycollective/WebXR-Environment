/**
 * `@realitycollective/iwsdk-environment` - the Meta IWSDK adapter.
 *
 * Re-exports the whole engine-free core, so an app installs this package and
 * nothing else.
 */
import { createSystem, type Entity, type World } from "@iwsdk/core";
import type {
  AudioDirectorOptions,
  EnvironmentDirectorOptions,
} from "@realitycollective/webxr-environment";
import { AudioDirector, EnvironmentDirector } from "@realitycollective/webxr-environment";
import type { IWSDKEnvironmentPortOptions } from "./environment-port.js";
import { IWSDKEnvironmentPort } from "./environment-port.js";
import type { IWSDKAudioPortOptions } from "./audio-port.js";
import { IWSDKAudioPort } from "./audio-port.js";

export type { IWSDKEnvironmentPortOptions } from "./environment-port.js";
export { IWSDKEnvironmentPort } from "./environment-port.js";
export type { IWSDKAudioPortOptions } from "./audio-port.js";
export { IWSDKAudioPort } from "./audio-port.js";

export * from "@realitycollective/webxr-environment";

export interface IWSDKEnvironmentOptions
  extends EnvironmentDirectorOptions,
    IWSDKEnvironmentPortOptions {
  /** Audio director + port options. Omit to set up the environment only. */
  readonly audio?: AudioDirectorOptions & IWSDKAudioPortOptions;
}

export interface IWSDKEnvironmentSetup {
  readonly environment: EnvironmentDirector;
  readonly environmentPort: IWSDKEnvironmentPort;
  readonly audio: AudioDirector | null;
  readonly audioPort: IWSDKAudioPort | null;
  /** Tear both directors down and remove everything they created. */
  dispose(): void;
}

const hosts = new WeakMap<World, IWSDKEnvironmentSetup>();

/** The setup registered for a world, if `registerEnvironment` has run. */
export function environmentFor(world: World): IWSDKEnvironmentSetup | undefined {
  return hosts.get(world);
}

/**
 * The per-frame tick.
 *
 * Neither director owns a loop, so something has to drive them, and on IWSDK
 * that something is a system - which means the environment stops advancing
 * when the session loses focus, exactly like the rest of the app.
 * `registerEnvironment` registers this for you; it is exported so an app that
 * builds its own system schedule can place it deliberately.
 *
 * IWSDK hands a system its delta in SECONDS and the directors take
 * milliseconds. That conversion happens here, once.
 */
export class EnvironmentSystem extends createSystem({}) {
  override update(delta: number): void {
    const setup = hosts.get(this.world as unknown as World);
    if (setup === undefined) return;
    const deltaMs = delta * 1000;
    setup.environment.update(deltaMs);
    setup.audio?.update(deltaMs);
  }
}

/**
 * One call to wire the environment (and optionally the audio) into an IWSDK
 * world, and register the system that ticks them.
 *
 * ```ts
 * const env = registerEnvironment(world, {
 *   presets: STOCK_PRESETS,
 *   initial: VOID,
 *   audio: { cues: [{ id: "hum", src: "/audio/hum.mp3", bus: "ambience", loop: true }] },
 * });
 * env.environment.transition("dusk", { durationMs: 8000 });
 * ```
 *
 * Passthrough is NOT read from the session here - push it in from whatever
 * already tracks capabilities (`env.environment.setPassthrough(...)`). The
 * session belongs to the platform layer, not to the environment.
 */
export function registerEnvironment(
  world: World,
  options: IWSDKEnvironmentOptions = {},
): IWSDKEnvironmentSetup {
  const existing = hosts.get(world);
  if (existing !== undefined) return existing;

  const environmentPort = new IWSDKEnvironmentPort(world, options);
  const environment = new EnvironmentDirector(environmentPort, options);

  let audio: AudioDirector | null = null;
  let audioPort: IWSDKAudioPort | null = null;
  if (options.audio !== undefined) {
    audioPort = new IWSDKAudioPort(world, options.audio);
    audio = new AudioDirector(audioPort, options.audio);
  }

  const setup: IWSDKEnvironmentSetup = {
    environment,
    environmentPort,
    audio,
    audioPort,
    dispose() {
      audio?.dispose();
      environment.dispose();
      hosts.delete(world);
    },
  };
  hosts.set(world, setup);
  world.registerSystem(EnvironmentSystem);
  return setup;
}

export type { Entity as IWSDKEntity };
