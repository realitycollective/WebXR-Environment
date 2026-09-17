import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AudioSource,
  AudioUtils,
  PlaybackMode,
  Quaternion,
  Transform,
  Vector3,
  type Entity,
} from "@iwsdk/core";
import type { AudioCue, AudioVoiceRequest } from "@realitycollective/iwsdk-environment";
import { IWSDKAudioPort } from "@realitycollective/iwsdk-environment";
import { asWorld, createFakeEntity, createFakeWorld } from "./helpers.js";

const CLICK: AudioCue = { id: "click", src: "/audio/click.mp3" };

/**
 * `AudioUtils` reaches into real component storage, which a fake entity does
 * not have. Everything else here - the components, the enums, the world shape
 * - is real; only the four static calls are intercepted, and `playing` is the
 * knob a test turns to say what IWSDK would be reporting.
 */
function stubAudioUtils() {
  const state = { playing: new Set<number>(), played: [] as number[], stopped: [] as number[] };
  const idOf = (entity: Entity) => (entity as unknown as { id: number }).id;
  vi.spyOn(AudioUtils, "play").mockImplementation((entity) => {
    state.played.push(idOf(entity));
  });
  vi.spyOn(AudioUtils, "stop").mockImplementation((entity) => {
    state.stopped.push(idOf(entity));
  });
  vi.spyOn(AudioUtils, "setVolume").mockImplementation(() => {});
  vi.spyOn(AudioUtils, "isPlaying").mockImplementation((entity) => state.playing.has(idOf(entity)));
  return state;
}

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("IWSDKAudioPort", () => {
  it("makes one entity per voice and plays it", () => {
    const audio = stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ gain: 0.5 }));

    expect(world.created).toHaveLength(1);
    const entity = world.created[0]!;
    const source = entity.components.get(AudioSource) as Record<string, unknown>;
    expect(source.src).toBe("/audio/click.mp3");
    expect(source.volume).toBe(0.5);
    expect(source.loop).toBe(false);
    expect(source.autoplay).toBe(false);
    // The core already applied the cue's policy, so IWSDK must not apply its
    // own on top - otherwise `restart` would mean two different things on two
    // engines.
    expect(source.playbackMode).toBe(PlaybackMode.Overlap);
    expect(audio.played).toEqual([entity.id]);
  });

  it("positions a voice that names a point, and marks it positional", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ at: [1, 2, 3] }));

    const entity = world.created[0]!;
    expect(Array.from(entity.getVectorView(Transform, "position")).slice(0, 3)).toEqual([1, 2, 3]);
    expect((entity.components.get(AudioSource) as Record<string, unknown>).positional).toBe(true);
  });

  it("marks a cue declared positional even with no point given", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ cue: { ...CLICK, positional: true } }));

    expect((world.created[0]!.components.get(AudioSource) as Record<string, unknown>).positional)
      .toBe(true);
  });

  it("parents voice entities where it was told to", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const parent = createFakeEntity();
    const port = new IWSDKAudioPort(asWorld(world), { parent: parent as never });

    port.start(request());
    expect(world.created[0]?.parent).toBe(parent);
  });

  it("reports a voice ended once IWSDK has played it and stopped", () => {
    // IWSDK reports whether a source IS playing, never that it just finished,
    // so the end is inferred from the transition - which is why the port needs
    // to have SEEN it playing first.
    const audio = stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    const voice = request();
    port.start(voice);
    const entity = world.created[0]!;

    audio.playing.add(entity.id);
    port.update(16);
    expect(voice.ended).not.toHaveBeenCalled();

    audio.playing.delete(entity.id);
    port.update(16);
    expect(voice.ended).toHaveBeenCalledOnce();
    expect(entity.destroyed).toBe(true);
    expect(audio.stopped).toEqual([entity.id]);

    // Nothing left to poll.
    port.update(16);
    expect(voice.ended).toHaveBeenCalledOnce();
  });

  it("never retires a looping voice on its own", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    const voice = request({ loop: true });
    port.start(voice);
    port.update(100_000);
    expect(voice.ended).not.toHaveBeenCalled();
    expect(world.created[0]?.destroyed).toBe(false);
  });

  it("reaps a voice that never starts, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world), { startTimeoutMs: 1000 });

    const voice = request();
    port.start(voice);
    port.update(999);
    expect(voice.ended).not.toHaveBeenCalled();

    port.update(1);
    expect(voice.ended).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(world.created[0]?.destroyed).toBe(true);
  });

  it("stops a voice on request, and ignores a stale id", () => {
    const audio = stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ voiceId: 4 }));
    port.stop(4);
    expect(audio.stopped).toEqual([world.created[0]!.id]);
    expect(world.created[0]?.destroyed).toBe(true);
    port.stop(4);
    port.stop(999);
    expect(audio.stopped).toHaveLength(1);
  });

  it("pushes a live gain change through, and ignores a stale id", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ voiceId: 2 }));
    port.setGain(2, 0.25);
    expect(AudioUtils.setVolume).toHaveBeenCalledWith(world.created[0], 0.25);

    port.setGain(999, 0.5);
    expect(AudioUtils.setVolume).toHaveBeenCalledOnce();
  });

  it("stops everything on dispose and refuses to start anything after", () => {
    const audio = stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(request({ voiceId: 1, loop: true }));
    port.dispose();
    expect(audio.stopped).toHaveLength(1);
    expect(world.created[0]?.destroyed).toBe(true);

    const late = request({ voiceId: 2 });
    port.start(late);
    expect(late.ended).toHaveBeenCalledOnce();
    expect(world.created).toHaveLength(1);

    port.update(16);
    port.dispose();
  });
});

describe("spatial attenuation", () => {
  it("writes the cue's fall-off onto the AudioSource, and nothing it did not name", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(
      request({
        at: [0, 0, 0],
        spatial: { refDistance: 4, rolloffFactor: 2, maxDistance: 30, model: "linear" },
      }),
    );
    const withSpatial = world.created.at(-1);
    expect(withSpatial?.components.get(AudioSource)?.["refDistance"]).toBe(4);
    expect(withSpatial?.components.get(AudioSource)?.["rolloffFactor"]).toBe(2);
    expect(withSpatial?.components.get(AudioSource)?.["maxDistance"]).toBe(30);
    expect(withSpatial?.components.get(AudioSource)?.["distanceModel"]).toBe("linear");

    port.start(request({ voiceId: 2, at: [0, 0, 0], spatial: { model: "exponential" } }));
    const sparse = world.created.at(-1);
    expect(sparse?.components.get(AudioSource)?.["distanceModel"]).toBe("exponential");
    expect(sparse?.components.get(AudioSource)).not.toHaveProperty("refDistance");

    port.start(request({ voiceId: 3, at: [0, 0, 0], spatial: { model: "inverse" } }));
    expect(world.created.at(-1)?.components.get(AudioSource)?.["distanceModel"]).toBe("inverse");
  });

  it("writes a cone in degrees and turns the entity to face where it points", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));

    port.start(
      request({
        at: [0, 0, 0],
        spatial: { cone: { inner: Math.PI / 2, outer: Math.PI, outsideGain: 0.25 } },
        facing: [0, 0, -1],
      }),
    );
    const entity = world.created.at(-1);
    const source = entity?.components.get(AudioSource);
    expect(source?.["coneInnerAngle"]).toBe(90);
    expect(source?.["coneOuterAngle"]).toBe(180);
    expect(source?.["coneOuterGain"]).toBe(0.25);

    // IWSDK hands the entity transform to the same three.js positional audio,
    // so +Z has to end up pointing the way the sound travels. The rotation is
    // asserted by its EFFECT: a quaternion and its negation are the same turn,
    // and pinning one of the two spellings would be a test of three.js.
    const orientation = entity?.getVectorView(Transform, "orientation") ?? [];
    const turn = new Quaternion(orientation[0], orientation[1], orientation[2], orientation[3]);
    const forward = new Vector3(0, 0, 1).applyQuaternion(turn);
    expect(forward.x).toBeCloseTo(0, 5);
    expect(forward.y).toBeCloseTo(0, 5);
    expect(forward.z).toBeCloseTo(-1, 5);
  });

  it("leaves a voice unturned when it faces nowhere", () => {
    stubAudioUtils();
    const world = createFakeWorld();
    const port = new IWSDKAudioPort(asWorld(world));
    port.start(request({ at: [0, 0, 0], facing: [0, 0, 0] }));
    const orientation = world.created.at(-1)?.getVectorView(Transform, "orientation");
    // Untouched: a zero-length direction is not a direction.
    expect(Array.from(orientation ?? [])).toEqual([0, 0, 0, 0]);
  });
});
