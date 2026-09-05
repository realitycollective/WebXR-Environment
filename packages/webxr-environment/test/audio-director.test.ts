import { describe, expect, it } from "vitest";
import type { AudioCue } from "@realitycollective/webxr-environment";
import { AudioDirector } from "@realitycollective/webxr-environment";
import { MinimalAudioPort, RecordingAudioPort, fakeClock } from "./helpers.js";

const CLICK: AudioCue = { id: "click", src: "/audio/click.mp3" };
const HUM: AudioCue = { id: "hum", src: "/audio/hum.mp3", bus: "ambience", loop: true };

function setup(cues: AudioCue[] = [CLICK, HUM], options = {}) {
  const port = new RecordingAudioPort();
  const director = new AudioDirector(port, { cues, ...options });
  return { port, director };
}

describe("AudioDirector", () => {
  describe("registry", () => {
    it("registers cues and hands them to the port to preload", () => {
      const { port, director } = setup();
      expect(port.loaded).toEqual(["click", "hum"]);
      expect(director.cueIds()).toEqual(["click", "hum"]);
      expect(director.has("click")).toBe(true);
      expect(director.cue("click")).toBe(CLICK);
      expect(director.cue("nope")).toBeUndefined();
    });

    it("replaces a cue registered twice under the same id", () => {
      const { director } = setup([CLICK]);
      const replacement: AudioCue = { id: "click", src: "/audio/other.mp3" };
      director.registerAll([replacement]);
      expect(director.cue("click")).toBe(replacement);
      expect(director.cueIds()).toEqual(["click"]);
    });

    it("drops a play of an unknown cue rather than throwing", () => {
      // A missing sound must never take gameplay down: the id usually arrives
      // from a feedback intent several layers away.
      const { port, director } = setup();
      expect(director.play("nope")).toBeNull();
      expect(port.started).toHaveLength(0);
    });
  });

  describe("playback", () => {
    it("starts a voice and reports it as active", () => {
      const { port, director } = setup();
      const voice = director.play("click");
      expect(voice).toEqual({ id: 1, cueId: "click", bus: "sfx" });
      expect(port.started).toHaveLength(1);
      expect(port.started[0]?.request.loop).toBe(false);
      expect(port.started[0]?.request.at).toBeNull();
      expect(director.activeVoices).toEqual([voice]);
    });

    it("retires a voice when the port reports it ended", () => {
      const { port, director } = setup();
      const voice = director.play("click");
      port.finish(voice!.id);
      expect(director.activeVoices).toHaveLength(0);
    });

    it("passes a position through and honours a loop override", () => {
      const { port, director } = setup();
      director.play("click", { at: [1, 2, 3], loop: true });
      expect(port.started[0]?.request.at).toEqual([1, 2, 3]);
      expect(port.started[0]?.request.loop).toBe(true);
    });

    it("stops a voice by handle or by id, and tolerates a stale one", () => {
      const { port, director } = setup();
      const first = director.play("click")!;
      const second = director.play("click")!;
      director.stop(first);
      director.stop(second.id);
      director.stop(999);
      expect(port.stopped).toEqual([first.id, second.id]);
      expect(director.activeVoices).toHaveLength(0);
    });

    it("stops every voice of one cue", () => {
      const { port, director } = setup();
      director.play("click");
      director.play("click");
      director.play("hum");
      director.stopCue("click");
      expect(port.stopped).toHaveLength(2);
      expect(director.activeVoices.map((voice) => voice.cueId)).toEqual(["hum"]);
    });

    it("stops everything, or everything on one bus", () => {
      const { director } = setup();
      director.play("click");
      director.play("hum");
      director.stopAll("ambience");
      expect(director.activeVoices.map((voice) => voice.cueId)).toEqual(["click"]);
      director.stopAll();
      expect(director.activeVoices).toHaveLength(0);
    });
  });

  describe("retrigger policy", () => {
    it("overlaps by default", () => {
      const { director } = setup();
      director.play("click");
      director.play("click");
      expect(director.activeVoices).toHaveLength(2);
    });

    it("restarts, stopping what was sounding first", () => {
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, policy: "restart" }],
      });
      const first = director.play("click")!;
      const second = director.play("click")!;
      expect(port.stopped).toEqual([first.id]);
      expect(director.activeVoices).toEqual([second]);
    });

    it("ignores a second play while the first is sounding", () => {
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, policy: "ignore" }],
      });
      const first = director.play("click")!;
      expect(director.play("click")).toBeNull();
      port.finish(first.id);
      expect(director.play("click")).not.toBeNull();
    });

    it("degrades to overlap on a fire-and-forget port", () => {
      // A port that cannot observe the end of playback reports it at once, so
      // nothing is ever "already sounding" as far as the policy can tell. That
      // is a documented consequence, not a silent one.
      const port = new RecordingAudioPort();
      port.fireAndForget = true;
      const director = new AudioDirector(port, { cues: [{ ...CLICK, policy: "ignore" }] });
      expect(director.play("click")).not.toBeNull();
      expect(director.play("click")).not.toBeNull();
      expect(director.activeVoices).toHaveLength(0);
    });
  });

  describe("throttle", () => {
    it("drops repeats inside the cue's minimum interval", () => {
      const clock = fakeClock();
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, minIntervalMs: 100 }],
        now: clock.now,
      });

      expect(director.play("click")).not.toBeNull();
      clock.advance(99);
      expect(director.play("click")).toBeNull();
      clock.advance(1);
      expect(director.play("click")).not.toBeNull();
      expect(port.started).toHaveLength(2);
    });
  });

  describe("mix", () => {
    it("multiplies master, bus, cue and play gains", () => {
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, gain: 0.5 }],
        busGains: { sfx: 0.5 },
        masterGain: 0.5,
      });
      director.play("click", { gain: 0.5 });
      expect(port.started[0]?.request.gain).toBeCloseTo(0.0625);
      expect(director.resolveGain("click", 0.5)).toBeCloseTo(0.0625);
      expect(director.resolveGain("nope")).toBe(0);
    });

    it("reads an unset bus as unity and refuses negative gains", () => {
      const { director } = setup();
      expect(director.getBusGain("anything")).toBe(1);
      director.setBusGain("sfx", -2);
      expect(director.getBusGain("sfx")).toBe(0);
      director.setMasterGain(-1);
      expect(director.masterGain).toBe(0);
    });

    it("pushes a bus change onto voices already sounding", () => {
      const { port, director } = setup();
      const voice = director.play("click")!;
      const hum = director.play("hum")!;
      director.setBusGain("sfx", 0.25);
      expect(port.voice(voice.id)?.gain).toBeCloseTo(0.25);
      expect(port.voice(hum.id)?.gain).toBe(1);

      director.setMasterGain(0.5);
      expect(port.voice(voice.id)?.gain).toBeCloseTo(0.125);
      expect(port.voice(hum.id)?.gain).toBeCloseTo(0.5);
    });

    it("does nothing when a gain is set to the value it already had", () => {
      const { port, director } = setup();
      const voice = director.play("click")!;
      director.setBusGain("sfx", 1);
      director.setMasterGain(1);
      expect(port.voice(voice.id)?.gain).toBe(1);
    });

    it("mutes a bus without losing the level behind it", () => {
      const { port, director } = setup();
      director.setBusGain("sfx", 0.8);
      const voice = director.play("click")!;
      director.setMuted(true, "sfx");
      expect(director.isMuted("sfx")).toBe(true);
      expect(port.voice(voice.id)?.gain).toBe(0);
      director.setMuted(false, "sfx");
      expect(port.voice(voice.id)?.gain).toBeCloseTo(0.8);
    });

    it("mutes everything, and ignores a repeated set", () => {
      const { port, director } = setup();
      const voice = director.play("hum")!;
      director.setMuted(true);
      expect(director.isMuted()).toBe(true);
      expect(port.voice(voice.id)?.gain).toBe(0);
      director.setMuted(true);
      director.setMuted(true, "sfx");
      director.setMuted(true, "sfx");
      expect(port.voice(voice.id)?.gain).toBe(0);
      director.setMuted(false);
      expect(port.voice(voice.id)?.gain).toBe(1);
    });

    it("skips a silent one-shot but still starts a silent loop", () => {
      // Unmuting mid-flight is exactly when an ambience bed needs to already
      // be running; a one-shot nobody will hear is just a wasted voice.
      const { port, director } = setup();
      director.setMuted(true);
      expect(director.play("click")).toBeNull();
      expect(director.play("hum")).not.toBeNull();
      expect(port.started).toHaveLength(1);
    });

    it("still records the throttle window for a play it skipped", () => {
      const clock = fakeClock();
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, minIntervalMs: 100 }],
        now: clock.now,
        masterGain: 0,
      });
      expect(director.play("click")).toBeNull();
      director.setMasterGain(1);
      expect(director.play("click")).toBeNull();
      clock.advance(100);
      expect(director.play("click")).not.toBeNull();
    });

    it("tolerates a port that cannot follow live gain changes", () => {
      const port = new MinimalAudioPort();
      const director = new AudioDirector(port, { cues: [CLICK] });
      director.play("click");
      expect(() => director.setBusGain("sfx", 0.5)).not.toThrow();
    });
  });

  describe("update", () => {
    it("ticks the port first, then retires voices whose duration elapsed", () => {
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, {
        cues: [{ ...CLICK, durationMs: 500 }, HUM],
      });
      director.play("click");
      director.play("hum");

      director.update(400);
      expect(port.updates).toEqual([400]);
      expect(director.activeVoices).toHaveLength(2);

      director.update(100);
      // The loop is untouched: it ends when someone stops it.
      expect(director.activeVoices.map((voice) => voice.cueId)).toEqual(["hum"]);
    });

    it("leaves voices with no declared duration alone", () => {
      const { director } = setup();
      director.play("click");
      director.update(100_000);
      expect(director.activeVoices).toHaveLength(1);
    });

    it("is silent after disposal", () => {
      const { port, director } = setup();
      director.dispose();
      director.update(16);
      expect(port.updates).toHaveLength(0);
    });
  });

  describe("disposal", () => {
    it("stops everything, disposes the port and refuses further work", () => {
      const { port, director } = setup();
      const voice = director.play("hum")!;
      director.dispose();

      expect(port.stopped).toEqual([voice.id]);
      expect(port.disposed).toBe(true);
      expect(() => director.play("click")).toThrow(/disposed/);
      expect(() => director.register(CLICK)).toThrow(/disposed/);
      expect(() => director.stop(1)).toThrow(/disposed/);
      expect(() => director.stopCue("click")).toThrow(/disposed/);
      expect(() => director.stopAll()).toThrow(/disposed/);
      expect(() => director.setBusGain("sfx", 1)).toThrow(/disposed/);
      expect(() => director.setMasterGain(0.5)).toThrow(/disposed/);
      expect(() => director.setMuted(true)).toThrow(/disposed/);
    });

    it("is idempotent, and tolerates a port with no dispose", () => {
      const port = new MinimalAudioPort();
      const director = new AudioDirector(port, { cues: [CLICK] });
      director.dispose();
      director.dispose();
      expect(port.stopped).toHaveLength(0);
    });

    it("defaults its clock to the wall clock", () => {
      // Nothing else exercises the default, and a broken default would only
      // show up as a throttle that never opens.
      const port = new RecordingAudioPort();
      const director = new AudioDirector(port, { cues: [{ ...CLICK, minIntervalMs: 0 }] });
      expect(director.play("click")).not.toBeNull();
      expect(director.play("click")).not.toBeNull();
    });
  });
});
