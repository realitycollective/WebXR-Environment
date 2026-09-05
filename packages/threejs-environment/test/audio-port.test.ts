import { afterEach, describe, expect, it, vi } from "vitest";
import { Group, PositionalAudio, Scene } from "three";
import type { AudioCue, AudioVoiceRequest } from "@realitycollective/threejs-environment";
import { ThreeAudioPort, createThreeAudio } from "@realitycollective/threejs-environment";
import { createTestListener, fakeBuffer } from "./helpers.js";

const CLICK: AudioCue = { id: "click", src: "/audio/click.mp3" };

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
    ended,
    ...overrides,
  } as AudioVoiceRequest & { ended: ReturnType<typeof vi.fn> };
}

/** A loader that resolves on demand, so "still decoding" is a testable state. */
function deferredLoader() {
  const resolvers: Array<(buffer: AudioBuffer) => void> = [];
  const rejecters: Array<(error: Error) => void> = [];
  return {
    calls: [] as string[],
    resolvers,
    loadAsync(url: string) {
      this.calls.push(url);
      return new Promise<AudioBuffer>((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      });
    },
    resolveAll(buffer = fakeBuffer()) {
      for (const resolve of resolvers.splice(0)) resolve(buffer);
      rejecters.length = 0;
    },
    rejectAll(error = new Error("404")) {
      for (const reject of rejecters.splice(0)) reject(error);
      resolvers.length = 0;
    },
  };
}

function setup(loader = deferredLoader()) {
  const { listener, context } = createTestListener();
  const scene = new Scene();
  scene.add(listener);
  const port = new ThreeAudioPort(listener, { loader, parent: scene });
  return { port, loader, listener, scene, context };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ThreeAudioPort", () => {
  it("caches a decoded buffer and only fetches it once", async () => {
    const { port, loader } = setup();
    const first = port.load(CLICK);
    const second = port.load(CLICK);
    loader.resolveAll();
    await Promise.all([first, second]);
    await port.load(CLICK);
    expect(loader.calls).toEqual(["/audio/click.mp3"]);
  });

  it("reports a failed load once and retries on the next play", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port, loader } = setup();
    const attempt = port.load(CLICK);
    loader.rejectAll();
    expect(await attempt).toBeNull();
    expect(warn).toHaveBeenCalledOnce();

    const retry = port.load(CLICK);
    loader.resolveAll();
    expect(await retry).not.toBeNull();
    expect(loader.calls).toHaveLength(2);
  });

  it("plays immediately once the buffer is cached", async () => {
    const { port, loader, context } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    port.start(request({ gain: 0.5 }));
    expect(context.sources).toHaveLength(1);
    expect(context.sources[0]?.started).toBe(true);
  });

  it("holds a play that arrives before the buffer, rather than dropping it", async () => {
    // The obvious implementation makes the first press of every button in a
    // session silent. Late is better than never.
    const { port, loader, context } = setup();
    const held = request();
    port.start(held);
    expect(context.sources).toHaveLength(0);

    loader.resolveAll();
    await vi.waitFor(() => expect(context.sources).toHaveLength(1));
    expect(held.ended).not.toHaveBeenCalled();
  });

  it("never starts a held play that was stopped while decoding", async () => {
    const { port, loader, context } = setup();
    port.start(request({ voiceId: 7 }));
    port.stop(7);
    loader.resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(context.sources).toHaveLength(0);
  });

  it("reports the voice ended when its buffer never arrives", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { port, loader } = setup();
    const held = request();
    port.start(held);
    loader.rejectAll();
    await vi.waitFor(() => expect(held.ended).toHaveBeenCalledOnce());
  });

  it("reports the voice ended when three.js says playback finished", async () => {
    const { port, loader, context } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    const voice = request();
    port.start(voice);
    context.sources[0]?.onended?.();
    expect(voice.ended).toHaveBeenCalledOnce();

    // A second report must not fire it again - the voice is already gone.
    context.sources[0]?.onended?.();
    expect(voice.ended).toHaveBeenCalledOnce();
  });

  it("stops a sounding voice and forgets it", async () => {
    const { port, loader, context } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    port.start(request({ voiceId: 3 }));
    port.stop(3);
    expect(context.sources[0]?.stopped).toBe(true);
    port.stop(3);
    port.stop(999);
  });

  it("parents a positional voice in the scene, at the requested point", async () => {
    const { port, loader, scene } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    port.start(request({ at: [1, 2, 3] }));
    const holder = scene.children.find((child) => child.name.startsWith("webxr-environment:voice"));
    expect(holder?.position.toArray()).toEqual([1, 2, 3]);
    expect(holder?.children[0]).toBeInstanceOf(PositionalAudio);

    port.stop(1);
    expect(scene.children).not.toContain(holder);
  });

  it("honours a cue marked positional even with no position given", async () => {
    const { port, loader, scene } = setup();
    const cue: AudioCue = { ...CLICK, positional: true };
    const ready = port.load(cue);
    loader.resolveAll();
    await ready;

    port.start(request({ cue }));
    const holder = scene.children.find((child) => child.name.startsWith("webxr-environment:voice"));
    expect(holder?.position.toArray()).toEqual([0, 0, 0]);
  });

  it("follows a live gain change", async () => {
    const { port, loader, context } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    port.start(request({ voiceId: 4, gain: 1 }));
    // Gain node 0 belongs to the listener; node 1 is this voice's. Reading it
    // back proves the value reached three.js rather than only the port's own
    // bookkeeping.
    const voiceGain = context.gains[1];
    expect(voiceGain?.gain.value).toBeCloseTo(1);

    port.setGain(4, 0.25);
    expect(voiceGain?.gain.value).toBeCloseTo(0.25);

    port.setGain(999, 0.5);
    expect(voiceGain?.gain.value).toBeCloseTo(0.25);
  });

  it("resumes the audio context, and says so when there is none", async () => {
    const { port, context } = setup();
    expect(await port.resume()).toBe(true);
    expect(context.state).toBe("running");

    const bare = new ThreeAudioPort({
      context: undefined,
      parent: null,
      getInput: () => ({}),
    } as never);
    expect(await bare.resume()).toBe(false);
  });

  it("refuses to start anything after disposal, and stops what was playing", async () => {
    const { port, loader, context } = setup();
    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;

    port.start(request({ voiceId: 5 }));
    port.dispose();
    expect(context.sources[0]?.stopped).toBe(true);

    const late = request({ voiceId: 6 });
    port.start(late);
    expect(late.ended).toHaveBeenCalledOnce();
    port.dispose();
  });

  it("abandons a held play if the port is disposed while it decodes", async () => {
    const { port, loader, context } = setup();
    port.start(request({ voiceId: 8 }));
    port.dispose();
    loader.resolveAll();
    await Promise.resolve();
    await Promise.resolve();
    expect(context.sources).toHaveLength(0);
  });

  it("defaults its parent to the listener's own", async () => {
    const { listener } = createTestListener();
    const group = new Group();
    group.add(listener);
    const loader = deferredLoader();
    const port = new ThreeAudioPort(listener, { loader });

    const ready = port.load(CLICK);
    loader.resolveAll();
    await ready;
    port.start(request({ at: [0, 1, 0] }));

    expect(group.children.some((child) => child.name.startsWith("webxr-environment:voice"))).toBe(
      true,
    );
  });
});

describe("createThreeAudio", () => {
  it("wires a director to a listener", async () => {
    const { listener } = createTestListener();
    const loader = deferredLoader();
    const { director, port } = createThreeAudio(listener, { cues: [CLICK], loader });
    loader.resolveAll();
    await vi.waitFor(() => expect(loader.calls).toHaveLength(1));

    const voice = director.play("click");
    expect(voice).not.toBeNull();
    director.dispose();
    expect(port).toBeInstanceOf(ThreeAudioPort);
  });
});
