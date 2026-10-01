/**
 * The Environment host conformance kit: host cases (the third kind in the
 * Masters' "Validation" section), shipped as data so a native app runs them
 * on its device against its REAL `environment` and `audio` slices.
 *
 * The director and the audio director are core logic, identical on every
 * platform; what can still differ is whether the host applies what it is
 * handed. So each case drives the real core over the real host, through this
 * package's ports, and reads back what the host is drawing or sounding with
 * the readbacks of `NativeEnvironmentTestHost` and `NativeAudioTestHost`:
 * every slot applied, passthrough suppressing sky and fog and restoring
 * them, a transition's in-between values reaching the host, the remembered
 * occlusion spec applied when passthrough starts, and the four audio
 * policies. A host without an `applyOcclusion` or an `audio` slice fails the
 * cases that need them, which is the point: the gap is visible.
 *
 * Runner-free, like the core suites: a case resolves on success and rejects
 * with a plain `Error` naming its row otherwise.
 */
import type { WorldPose } from "@realitycollective/webxr-environment";
import {
  AudioDirector,
  DEFAULT_OCCLUSION,
  DUSK,
  EnvironmentDirector,
  NOON,
  resolveLightEstimation,
  type AudioCue,
  type FogSpec,
  type KeyLightSpec,
  type SkySpec, distanceGain } from "@realitycollective/webxr-environment";
import { NativeAudioPort } from "./audio-port.js";
import { NativeEnvironmentPort } from "./environment-port.js";
import type {
  NativeAudioHost,
  NativeAudioTestHost,
  NativeEnvironmentHost,
  NativeEnvironmentTestHost,
} from "./native-types.js";

/** The real slices under test, and their readbacks. */
export interface NativeEnvironmentHostConformanceSetup {
  environment: NativeEnvironmentHost;
  environmentTest: NativeEnvironmentTestHost;
  /** The audio slice, or `undefined` when the host has none (the audio cases then fail). */
  audio: NativeAudioHost | undefined;
  audioTest: NativeAudioTestHost | undefined;
  /** A short sound the host can play, as a cue `src`. */
  cueSrc: string;
  /** An equirectangular sky image the host can load, as a texture sky `src`. Default `"kit://sky.hdr"`, a name the app resolves. */
  skySrc?: string;
  /** The viewer's head pose now, from the `input` slice, for the listener case. Optional; that case fails without it. */
  headPose?: () => WorldPose;
}

/** One check a native host must pass. `name` is `environment/<row>` or `audio/<row>`. */
export interface NativeEnvironmentHostConformanceCase {
  name: string;
  run(setup: NativeEnvironmentHostConformanceSetup): Promise<void>;
}

const SLOTS = ["sky", "fog", "ambient", "key", "ibl"] as const;

function fail(name: string, message: string): never {
  throw new Error(`[${name}] ${message}`);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** A handful of microtask turns, for a host that answers light estimation asynchronously. */
const SETTLE_TURNS = 4;
async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) await Promise.resolve();
}

function hostCase(
  name: string,
  run: (setup: NativeEnvironmentHostConformanceSetup, name: string) => void | Promise<void>,
): NativeEnvironmentHostConformanceCase {
  return { name, run: async (setup) => run(setup, name) };
}

/** The director's resolved value for a slot, the value the host must be drawing. */
function resolved(director: EnvironmentDirector, slot: (typeof SLOTS)[number]): unknown {
  return director.applied[slot];
}

function audioOf(name: string, setup: NativeEnvironmentHostConformanceSetup) {
  if (!setup.audio || !setup.audioTest) {
    fail(name, "the host has no audio slice, so no cue can sound");
  }
  let now = 0;
  const director = new AudioDirector(new NativeAudioPort(setup.audio), { now: () => now });
  const cue = (id: string, extra: Partial<AudioCue> = {}): AudioCue => ({ id, src: setup.cueSrc, loop: true, ...extra });
  const sounding = (cueId: string) => setup.audioTest!.voices().filter((voice) => voice.cueId === cueId).length;
  return {
    director,
    cue,
    sounding,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The Environment and audio host conformance cases. See the file comment. */
export function nativeEnvironmentHostConformanceCases(): NativeEnvironmentHostConformanceCase[] {
  return [
    hostCase("environment/the host draws every slot it is handed", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      try {
        director.apply(NOON);
        for (const slot of SLOTS) {
          if (!same(environmentTest.applied(slot), resolved(director, slot))) {
            fail(name, `${slot}: the host draws ${JSON.stringify(environmentTest.applied(slot))}, the director applied ${JSON.stringify(resolved(director, slot))}`);
          }
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/passthrough suppresses sky and fog, and they return unchanged", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      try {
        director.apply(NOON);
        director.setPassthrough(true);
        if (environmentTest.applied("sky") !== null || environmentTest.applied("fog") !== null) {
          fail(name, "sky and fog must be null on the host while passthrough is on");
        }
        if (!same(environmentTest.applied("ambient"), resolved(director, "ambient"))) {
          fail(name, "passthrough must leave the ambient light alone");
        }
        director.setPassthrough(false);
        if (!same(environmentTest.applied("sky"), resolved(director, "sky"))) {
          fail(name, "the sky did not return unchanged after passthrough");
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/a transition's in-between values reach the host each frame", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      try {
        director.apply(NOON);
        director.transition(DUSK, { durationMs: 1000, easing: "linear" });
        director.update(500);
        const midway = resolved(director, "ambient");
        if (!same(environmentTest.applied("ambient"), midway)) {
          fail(name, `midway the host draws ${JSON.stringify(environmentTest.applied("ambient"))}, expected ${JSON.stringify(midway)}`);
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/an occlusion spec is remembered and applied when passthrough starts", ({ environment, environmentTest }, name) => {
      if (typeof environment.applyOcclusion !== "function") {
        fail(name, "the host has no applyOcclusion, so occlusion is unsupported");
      }
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      try {
        director.setOcclusion(DEFAULT_OCCLUSION);
        if (environmentTest.appliedOcclusion()) {
          fail(name, "occlusion reached the host while passthrough was off");
        }
        director.setPassthrough(true);
        if (!same(environmentTest.appliedOcclusion(), director.occlusion)) {
          fail(name, `on passthrough the host applies ${JSON.stringify(environmentTest.appliedOcclusion())}, expected the remembered ${JSON.stringify(director.occlusion)}`);
        }
        // Leave the host as it was found: occlusion off and passthrough off,
        // so a second run on the same host starts from nothing applied.
        director.setOcclusion(null);
        director.setPassthrough(false);
        if (environmentTest.appliedOcclusion()) {
          fail(name, "occlusion stayed applied after it was cleared; the host must turn it off when told");
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/every sky kind is drawn as the kind it was given, not flattened to one", (setup, name) => {
      const { environment, environmentTest } = setup;
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      const variants: readonly SkySpec[] = [
        { kind: "solid", colour: [0.2, 0.4, 0.8] },
        { kind: "gradient", top: [0.1, 0.2, 0.3], bottom: [0.4, 0.5, 0.6] },
        { kind: "texture", src: setup.skySrc ?? "kit://sky.hdr" },
      ];
      try {
        director.apply(NOON);
        for (const sky of variants) {
          director.apply({ sky });
          if (environmentTest.drawnSkyKind() !== sky.kind) {
            fail(name, `a "${sky.kind}" sky is drawn as "${String(environmentTest.drawnSkyKind())}"`);
          }
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/every fog kind is drawn as the kind it was given, not flattened to one", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      const variants: readonly FogSpec[] = [
        { kind: "linear", colour: [0.5, 0.5, 0.5], near: 1, far: 10 },
        { kind: "exponential", colour: [0.5, 0.5, 0.5], density: 0.01 },
      ];
      try {
        director.apply(NOON);
        for (const fog of variants) {
          director.apply({ fog });
          if (environmentTest.drawnFogKind() !== fog.kind) {
            fail(name, `"${fog.kind}" fog is drawn as "${String(environmentTest.drawnFogKind())}"`);
          }
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/a key light's castShadow actually turns the host's shadow on and off", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      const withShadow: KeyLightSpec = { colour: [1, 1, 1], intensity: 1, direction: [0, -1, 0], castShadow: true };
      try {
        director.apply(NOON);
        director.apply({ key: withShadow });
        if (environmentTest.drawnKeyLightCastsShadow() !== true) {
          fail(name, `castShadow: true is drawn as ${JSON.stringify(environmentTest.drawnKeyLightCastsShadow())}`);
        }
        director.apply({ key: { ...withShadow, castShadow: false } });
        if (environmentTest.drawnKeyLightCastsShadow() !== false) {
          fail(name, `castShadow: false is drawn as ${JSON.stringify(environmentTest.drawnKeyLightCastsShadow())}`);
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase("environment/an ibl spec makes materials reflect it, and null turns that back off", ({ environment, environmentTest }, name) => {
      const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
      try {
        director.apply(NOON);
        director.apply({ ibl: { kind: "gradient", top: [0.6, 0.6, 0.6], bottom: [0.2, 0.2, 0.2] } });
        if (environmentTest.drawnIblActive() !== true) {
          fail(name, `an ibl spec leaves the host's materials reflecting ${JSON.stringify(environmentTest.drawnIblActive())}`);
        }
        director.apply({ ibl: null });
        if (environmentTest.drawnIblActive() !== false) {
          fail(name, `ibl: null leaves the host's materials still reflecting ${JSON.stringify(environmentTest.drawnIblActive())}`);
        }
      } finally {
        director.dispose();
      }
    }),
    hostCase(
      "environment/light estimation reaches the host, and once it measures something the estimate overlays ambient, key and ibl",
      async ({ environment, environmentTest }, name) => {
        if (typeof environment.applyLightEstimation !== "function" || typeof environment.onLightEstimate !== "function") {
          // A host may legitimately have neither at all - light estimation on
          // a headset with no light sensor, say - and `EnvironmentDirector`
          // already reports that as "unsupported" on its own (see the core
          // `environmentPortContractCases`). There is nothing this case can
          // exercise against a host that was never asked to support it.
          return;
        }
        const director = new EnvironmentDirector(new NativeEnvironmentPort(environment));
        try {
          director.apply(NOON);
          const before = resolved(director, "ambient");
          director.setLightEstimation(true);
          if (!same(environmentTest.appliedLightEstimation(), resolveLightEstimation({}))) {
            fail(
              name,
              `applyLightEstimation was reached with ${JSON.stringify(environmentTest.appliedLightEstimation())}, expected the resolved default request`,
            );
          }
          await settle();
          const state = director.getSensing("lightEstimation").state;
          const overlaid = !same(resolved(director, "ambient"), before);
          // "unavailable" is the documented, legitimate way to say "asked, but
          // nothing to measure right now" - a host may report that instead of
          // ever producing an estimate. Silence - neither an estimate nor a
          // report - is the one outcome that fails this.
          if (!overlaid && state !== "unavailable") {
            fail(
              name,
              `the host neither produced an estimate nor reported light estimation unavailable within ${SETTLE_TURNS} turns - it did nothing`,
            );
          }
        } finally {
          director.dispose();
        }
      },
    ),
    hostCase("audio/a positional voice attenuates by the core defaults, inverse from 1 m", (setup, name) => {
      const a = audioOf(name, setup);
      const read = setup.audioTest?.voiceDistanceGain;
      const listener = setup.audioTest?.listenerPose;
      if (typeof read !== "function" || typeof listener !== "function") {
        fail(name, "the test host has no voiceDistanceGain or listenerPose readback, so attenuation cannot be checked");
      }
      try {
        a.director.register(a.cue("rc-kit-near", { positional: true }));
        a.director.register(a.cue("rc-kit-far", { positional: true }));
        const origin = listener.call(setup.audioTest).position;
        // A looping cue always starts a voice: the director drops only a silent one-shot, a throttled or an ignored play.
        const near = a.director.play("rc-kit-near", { at: [origin[0] + 0.5, origin[1], origin[2]] })!;
        const far = a.director.play("rc-kit-far", { at: [origin[0] + 3, origin[1], origin[2]] })!;
        const expectedNear = distanceGain(0.5, null);
        const expectedFar = distanceGain(3, null);
        const gotNear = read.call(setup.audioTest, near.id);
        const gotFar = read.call(setup.audioTest, far.id);
        if (Math.abs(gotNear - expectedNear) > 0.05) fail(name, `a voice 0.5 m away must be at full volume (${expectedNear}), the host has it at ${gotNear}`);
        if (Math.abs(gotFar - expectedFar) > 0.05) fail(name, `a voice 3 m away must be at ${expectedFar.toFixed(3)} by the inverse model from 1 m, the host has it at ${gotFar}`);
      } finally {
        a.director.dispose();
      }
    }),
    hostCase("audio/the listener is at the viewer's head", (setup, name) => {
      const listener = setup.audioTest?.listenerPose;
      if (typeof listener !== "function") fail(name, "the test host has no listenerPose readback");
      if (typeof setup.headPose !== "function") fail(name, "the kit was given no headPose; pass the input slice's head pose");
      const head = setup.headPose();
      const at = listener.call(setup.audioTest);
      const apart = Math.hypot(at.position[0] - head.position[0], at.position[1] - head.position[1], at.position[2] - head.position[2]);
      if (apart > 0.01) fail(name, `the listener is ${apart.toFixed(3)} m from the head; it must follow the head every frame`);
      const dot = at.orientation[0] * head.orientation[0] + at.orientation[1] * head.orientation[1] + at.orientation[2] * head.orientation[2] + at.orientation[3] * head.orientation[3];
      if (Math.abs(dot) < 0.999) fail(name, "the listener does not face the way the head faces");
    }),
    hostCase("audio/overlap, the default, starts another voice", (setup, name) => {
      const a = audioOf(name, setup);
      try {
        a.director.register(a.cue("rc-kit-overlap"));
        a.director.play("rc-kit-overlap");
        a.director.play("rc-kit-overlap");
        if (a.sounding("rc-kit-overlap") !== 2) fail(name, `${a.sounding("rc-kit-overlap")} voices sound, expected 2`);
      } finally {
        a.director.dispose();
      }
    }),
    hostCase("audio/restart stops the sounding voice, then starts one", (setup, name) => {
      const a = audioOf(name, setup);
      try {
        a.director.register(a.cue("rc-kit-restart", { policy: "restart" }));
        a.director.play("rc-kit-restart");
        a.director.play("rc-kit-restart");
        if (a.sounding("rc-kit-restart") !== 1) fail(name, `${a.sounding("rc-kit-restart")} voices sound, expected 1`);
      } finally {
        a.director.dispose();
      }
    }),
    hostCase("audio/ignore drops a play while the cue sounds", (setup, name) => {
      const a = audioOf(name, setup);
      try {
        a.director.register(a.cue("rc-kit-ignore", { policy: "ignore" }));
        const first = a.director.play("rc-kit-ignore");
        const second = a.director.play("rc-kit-ignore");
        if (second !== null || a.sounding("rc-kit-ignore") !== 1 || first === null) {
          fail(name, `${a.sounding("rc-kit-ignore")} voices sound, expected the first one only`);
        }
      } finally {
        a.director.dispose();
      }
    }),
    hostCase("audio/minIntervalMs coalesces fast triggers", (setup, name) => {
      const a = audioOf(name, setup);
      try {
        a.director.register(a.cue("rc-kit-throttle", { minIntervalMs: 200 }));
        a.director.play("rc-kit-throttle");
        a.advance(100);
        a.director.play("rc-kit-throttle");
        if (a.sounding("rc-kit-throttle") !== 1) fail(name, "a play 100 ms after the last, inside 200 ms, still sounded");
        a.advance(150);
        a.director.play("rc-kit-throttle");
        if (a.sounding("rc-kit-throttle") !== 2) fail(name, "a play 250 ms after the last was dropped");
      } finally {
        a.director.dispose();
      }
    }),
    hostCase("audio/stop silences the voice it names", (setup, name) => {
      const a = audioOf(name, setup);
      try {
        a.director.register(a.cue("rc-kit-stop"));
        a.director.stop(a.director.play("rc-kit-stop")!);
        if (a.sounding("rc-kit-stop") !== 0) fail(name, "the host still sounds a stopped voice");
      } finally {
        a.director.dispose();
      }
    }),
  ];
}
