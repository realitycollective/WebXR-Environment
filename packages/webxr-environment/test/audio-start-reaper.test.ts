/**
 * `AudioStartReaper`, engine-free: the shared rule every `AudioPort` composes
 * to release a voice it started but never confirmed as playing. See the
 * class's file comment for the rule itself; this only proves the mechanism.
 */
import { describe, expect, it } from "vitest";
import { AudioStartReaper, DEFAULT_AUDIO_START_TIMEOUT_MS } from "../src/audio-start-reaper.js";
import type { AudioCue } from "../src/audio.js";

const CUE: AudioCue = { id: "click", src: "click.mp3" };

describe("AudioStartReaper", () => {
  it("defaults to 10 000ms, IWSDK's original constant", () => {
    expect(DEFAULT_AUDIO_START_TIMEOUT_MS).toBe(10_000);
    const reaper = new AudioStartReaper();
    expect(reaper.startTimeoutMs).toBe(10_000);
  });

  it("times a tracked voice out once it has waited startTimeoutMs, and never again", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 1000 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: CUE }, () => (calls += 1));

    reaper.update(999);
    expect(calls).toBe(0);

    reaper.update(1);
    expect(calls).toBe(1);

    // Nothing left to time out.
    reaper.update(10_000);
    expect(calls).toBe(1);
  });

  it("splits the wait across several update() calls", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 100 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: CUE }, () => (calls += 1));

    for (let i = 0; i < 9; i += 1) reaper.update(10);
    expect(calls).toBe(0);
    reaper.update(10);
    expect(calls).toBe(1);
  });

  it("confirmStarted cancels the timeout, however long the voice then runs", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 100 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: CUE }, () => (calls += 1));

    reaper.update(50);
    reaper.confirmStarted(1);
    reaper.update(1_000_000);
    expect(calls).toBe(0);
  });

  it("release cancels the timeout, exactly like confirmStarted", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 100 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: CUE }, () => (calls += 1));

    reaper.release(1);
    reaper.update(1_000_000);
    expect(calls).toBe(0);
  });

  it("confirmStarted and release on an id nobody tracked are no-ops", () => {
    const reaper = new AudioStartReaper();
    expect(() => reaper.confirmStarted(999)).not.toThrow();
    expect(() => reaper.release(999)).not.toThrow();
  });

  it("never tracks a looping voice", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 10 });
    let calls = 0;
    reaper.track(1, { loop: true, cue: CUE }, () => (calls += 1));
    reaper.update(1_000_000);
    expect(calls).toBe(0);
  });

  it("never tracks a voice whose cue declares its own durationMs", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 10 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: { ...CUE, durationMs: 60_000 } }, () => (calls += 1));
    reaper.update(1_000_000);
    expect(calls).toBe(0);
  });

  it("tracks several voices independently", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 100 });
    const finished: number[] = [];
    reaper.track(1, { loop: false, cue: CUE }, () => finished.push(1));
    reaper.update(60);
    reaper.track(2, { loop: false, cue: CUE }, () => finished.push(2));
    reaper.update(60);
    expect(finished).toEqual([1]);
    reaper.update(60);
    expect(finished).toEqual([1, 2]);
  });

  it("clear() stops watching every tracked voice without calling anything back", () => {
    const reaper = new AudioStartReaper({ startTimeoutMs: 10 });
    let calls = 0;
    reaper.track(1, { loop: false, cue: CUE }, () => (calls += 1));
    reaper.track(2, { loop: false, cue: CUE }, () => (calls += 1));
    reaper.clear();
    reaper.update(1_000_000);
    expect(calls).toBe(0);
  });

  it("update on an instance with nothing tracked does nothing", () => {
    const reaper = new AudioStartReaper();
    expect(() => reaper.update(1_000_000)).not.toThrow();
  });
});
