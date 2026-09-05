/**
 * The director as a plain sink.
 *
 * `play(cueId, options?)` is the whole inbound surface, and this pins the
 * behaviour an app relies on when it binds an event source to it: an unknown
 * cue is dropped rather than thrown, the caller's requested loudness is
 * RELATIVE and the app's mix still applies over it, and unsubscribing the
 * app's own binding is the only thing that stops the sounds.
 *
 * There is deliberately no sibling package here - not imported, not named in a
 * type, not reproduced as a copy. The source below is an anonymous emitter
 * standing in for whatever the app happens to have, because that is exactly
 * how much this package knows about it.
 */
import { describe, expect, it } from "vitest";
import type { AudioCue } from "@realitycollective/webxr-environment";
import { AudioDirector } from "@realitycollective/webxr-environment";
import { RecordingAudioPort } from "./helpers.js";

const CLICK: AudioCue = { id: "click", src: "/audio/click.mp3" };
const THUD: AudioCue = { id: "thud", src: "/audio/thud.mp3" };

/** Stands in for any event source an app might already have. */
function emitter<T>() {
  const listeners = new Set<(value: T) => void>();
  return {
    on(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value: T): void {
      for (const listener of [...listeners]) listener(value);
    },
  };
}

describe("AudioDirector as a sink an app binds to", () => {
  it("plays what an arbitrary event source asks it to, and stops when unbound", () => {
    const port = new RecordingAudioPort();
    const audio = new AudioDirector(port, { cues: [CLICK, THUD] });
    const source = emitter<{ sound: string; strength: number }>();

    // The binding is one line, in the app, where both halves are in scope.
    const unbind = source.on(({ sound, strength }) => audio.play(sound, { gain: strength }));

    source.emit({ sound: "click", strength: 0.5 });
    source.emit({ sound: "thud", strength: 1 });

    expect(port.started.map((voice) => voice.request.cue.id)).toEqual(["click", "thud"]);
    expect(port.started[0]?.request.gain).toBeCloseTo(0.5);

    unbind();
    source.emit({ sound: "click", strength: 1 });
    expect(port.started).toHaveLength(2);
  });

  it("drops a cue it does not know, so a bad binding cannot take the app down", () => {
    const port = new RecordingAudioPort();
    const audio = new AudioDirector(port, { cues: [CLICK] });
    const source = emitter<string>();
    source.on((sound) => audio.play(sound));

    expect(() => source.emit("never-registered")).not.toThrow();
    expect(port.started).toHaveLength(0);
  });

  it("treats a caller's gain as relative, so the app's mix still wins", () => {
    // A source asking for full volume must not be able to override the level
    // the player set. Anything binding to this is a peer, not an owner.
    const port = new RecordingAudioPort();
    const audio = new AudioDirector(port, { cues: [CLICK], busGains: { sfx: 0.25 } });

    audio.play("click", { gain: 1 });

    expect(port.started[0]?.request.gain).toBeCloseTo(0.25);
  });
});
