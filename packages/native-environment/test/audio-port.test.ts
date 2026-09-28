import { describe, expect, it, vi } from "vitest";
import type { AudioCue, AudioVoiceRequest } from "@realitycollective/webxr-environment";
import { NativeAudioPort } from "../src/audio-port.js";
import { createFakeAudioHost } from "./helpers.js";

const CLICK: AudioCue = { id: "click", src: "audio/click.mp3" };

function request(overrides: Partial<AudioVoiceRequest> = {}): AudioVoiceRequest & {
  ended: ReturnType<typeof vi.fn>;
} {
  const ended = vi.fn();
  return {
    voiceId: 1,
    cue: CLICK,
    gain: 1,
    loop: false,
    at: null,
    spatial: null,
    facing: null,
    ended,
    ...overrides,
  } as AudioVoiceRequest & { ended: ReturnType<typeof vi.fn> };
}

describe("NativeAudioPort", () => {
  it("sends the host a request with ended removed", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    const voice = request();

    port.start(voice);

    expect(host.requests).toEqual([
      { voiceId: 1, cue: CLICK, gain: 1, loop: false, at: null, spatial: null, facing: null },
    ]);
    expect(voice.ended).not.toHaveBeenCalled();
  });

  it("runs ended, once, when the host reports onVoiceEnded", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    const voice = request();
    port.start(voice);

    host.emitVoiceEnded(1);
    host.emitVoiceEnded(1);

    expect(voice.ended).toHaveBeenCalledOnce();
  });

  it("never calls host.stop for a voice that has already ended", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    const voice = request();
    port.start(voice);

    host.emitVoiceEnded(1);
    port.stop(1);

    expect(host.stopped).toEqual([]);
  });

  it("stops a still-sounding voice, once", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    port.start(request());

    port.stop(1);
    port.stop(1);

    expect(host.stopped).toEqual([1]);
  });

  it("does nothing for a voiceId nobody started", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    port.stop(99);
    expect(host.stopped).toEqual([]);
  });

  it("grows load and setGain when the host has them", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);

    port.load?.(CLICK);
    port.setGain?.(1, 0.5);

    expect(host.load).toHaveBeenCalledWith(CLICK);
    expect(host.setGain).toHaveBeenCalledWith(1, 0.5);
  });

  it("omits load and setGain when the host has neither", () => {
    const host = createFakeAudioHost({ load: false, setGain: false });
    const port = new NativeAudioPort(host);
    expect(port.load).toBeUndefined();
    expect(port.setGain).toBeUndefined();
  });

  it("ends every request immediately once disposed, without reaching the host", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    port.dispose();

    const voice = request();
    port.start(voice);

    expect(voice.ended).toHaveBeenCalledOnce();
    expect(host.requests).toEqual([]);
  });

  it("releases a voice the host never reports on, after the start timeout, and tells the host to stop it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host, { startTimeoutMs: 1000 });
    const voice = request();

    port.start(voice);
    port.update(999);
    expect(voice.ended).not.toHaveBeenCalled();

    port.update(1);
    expect(voice.ended).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(host.stopped).toEqual([1]);

    // A late report for the same id finds nothing left to end.
    host.emitVoiceEnded(1);
    expect(voice.ended).toHaveBeenCalledOnce();
  });

  it("never reaps a looping voice by the start timeout", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host, { startTimeoutMs: 10 });
    const voice = request({ loop: true });

    port.start(voice);
    port.update(1_000_000);
    expect(voice.ended).not.toHaveBeenCalled();
  });

  it("never reaps a voice whose cue declares its own durationMs by the start timeout", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host, { startTimeoutMs: 10 });
    const voice = request({ cue: { ...CLICK, durationMs: 60_000 } });

    port.start(voice);
    port.update(1_000_000);
    expect(voice.ended).not.toHaveBeenCalled();
  });

  it("stops watching a voice once onVoiceEnded reports it, so the start timeout never fires for it", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host, { startTimeoutMs: 10 });
    const voice = request();

    port.start(voice);
    host.emitVoiceEnded(1);
    port.update(1_000_000);
    expect(voice.ended).toHaveBeenCalledOnce();
  });

  it("skips a voice another one's ended callback already stopped, when its own timeout comes up in the same update()", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host, { startTimeoutMs: 100 });

    const second = request({ voiceId: 2 });
    const first = request({
      voiceId: 1,
      ended: vi.fn(() => port.stop(2)),
    });
    port.start(first);
    port.start(second);

    expect(() => port.update(101)).not.toThrow();

    expect(first.ended).toHaveBeenCalledOnce();
    expect(second.ended).not.toHaveBeenCalled();
    // Only voice 1's timeout actually ran the warn-and-stop path; voice 2's
    // was already gone from `#ended` by the time its own timeout came up - it
    // was still stopped, just via the reentrant `port.stop(2)` above, once.
    expect(warn).toHaveBeenCalledOnce();
    expect(host.stopped).toEqual([1, 2]);
  });

  it("dispose is safe to call twice, and stops listening to onVoiceEnded", () => {
    const host = createFakeAudioHost();
    const port = new NativeAudioPort(host);
    const voice = request();
    port.start(voice);

    port.dispose();
    port.dispose();
    host.emitVoiceEnded(1);

    expect(voice.ended).not.toHaveBeenCalled();
  });
});
