/**
 * The host profile a native bundle runs in, installed once per runtime: the
 * globals a Hermes host does not provide and the core needs, and nothing
 * else. Every other free global (`window`, `document`, `fetch`, `Intl`) is
 * absent on purpose, and the bundle gate refuses a bundle that names one.
 *
 * - Timers over a VIRTUAL clock: `setTimeout`, `clearTimeout`, `setInterval`,
 *   `clearInterval`. They advance only when the frame loop says so
 *   (`advanceClock`), which is what makes a replay a pure function of its
 *   frames and lets a kit settle its promises deterministically. A second
 *   bundle evaluated in the same runtime reuses the first clock.
 * - `performance.now` over the same clock.
 * - `setImmediate` as a 0 ms timer: the promise-job pump on the React
 *   Native build of Hermes.
 * - `console` line splitting at 900 bytes: `liblog` truncates longer lines.
 * - `TextDecoder` for UTF-8, where absent.
 */
interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export interface VirtualClock {
  now(): number;
  /** Advance by `ms` and run every timer that came due, in order; returns how many fired. */
  advance(ms: number): number;
  pending(): number;
}

const g = globalThis as Record<string, unknown>;

function installVirtualClock(): VirtualClock {
  const timers: Timer[] = [];
  let now = 0;
  let nextId = 1;
  const clock: VirtualClock = {
    now: () => now,
    advance(ms: number): number {
      const target = now + ms;
      let fired = 0;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > target) break;
        timers.shift();
        now = next.at;
        fired += 1;
        if (next.every !== undefined) timers.push({ id: next.id, at: next.at + next.every, fn: next.fn, every: next.every });
        next.fn();
      }
      now = target;
      return fired;
    },
    pending: () => timers.length,
  };
  const clear = (id: number): void => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  g.setTimeout = (fn: () => void, ms = 0): number => {
    const id = nextId++;
    timers.push({ id, at: now + Math.max(0, ms), fn });
    return id;
  };
  g.clearTimeout = clear;
  g.setInterval = (fn: () => void, ms = 0): number => {
    const id = nextId++;
    const every = Math.max(1, ms);
    timers.push({ id, at: now + every, fn, every });
    return id;
  };
  g.clearInterval = clear;
  g.setImmediate = (fn: () => void): number => (g.setTimeout as (fn: () => void, ms?: number) => number)(fn, 0);
  g.__rcVirtualClock = clock;
  return clock;
}

export const virtualClock: VirtualClock =
  typeof g.__rcVirtualClock === "object" && g.__rcVirtualClock !== null ? (g.__rcVirtualClock as VirtualClock) : installVirtualClock();

if (typeof g.performance === "undefined") {
  g.performance = { now: () => virtualClock.now() };
}

/** Which engine runs this bundle, for the report line. */
export function hostName(): string {
  if (typeof g.HermesInternal === "object" && g.HermesInternal !== null) return "hermes";
  const process = g.process as { versions?: { node?: string } } | undefined;
  if (typeof process?.versions?.node === "string") return `node ${process.versions.node}`;
  return "unknown";
}

if (typeof g.TextDecoder === "undefined") {
  class TextDecoderShim {
    readonly encoding = "utf-8";
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return "";
      const u8 = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      let out = "";
      for (let i = 0; i < u8.length; ) {
        const b = u8[i]!;
        let cp: number;
        if (b < 0x80) {
          cp = b;
          i += 1;
        } else if (b < 0xe0) {
          cp = ((b & 0x1f) << 6) | (u8[i + 1]! & 0x3f);
          i += 2;
        } else if (b < 0xf0) {
          cp = ((b & 0x0f) << 12) | ((u8[i + 1]! & 0x3f) << 6) | (u8[i + 2]! & 0x3f);
          i += 3;
        } else {
          cp = ((b & 0x07) << 18) | ((u8[i + 1]! & 0x3f) << 12) | ((u8[i + 2]! & 0x3f) << 6) | (u8[i + 3]! & 0x3f);
          i += 4;
        }
        out += cp > 0xffff ? String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)) : String.fromCharCode(cp);
      }
      return out;
    }
  }
  g.TextDecoder = TextDecoderShim;
}

/** `liblog` cuts a line past about 1 KB; the shell prints each chunk as its own line. */
const LINE_LIMIT = 900;
const originalLog = (g.console as { log(...a: unknown[]): void }).log.bind(g.console);
(g.console as { log(...a: unknown[]): void }).log = (...args: unknown[]): void => {
  const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  if (line.length <= LINE_LIMIT) {
    originalLog(line);
    return;
  }
  for (let i = 0; i < line.length; i += LINE_LIMIT) originalLog(line.slice(i, i + LINE_LIMIT));
};

/** The object the shell installs beside `__rcHost`: the mode flag and the test host. Created empty under Node. */
export function shellGlobal(): Record<string, unknown> {
  if (typeof g.__rcShell !== "object" || g.__rcShell === null) g.__rcShell = {};
  return g.__rcShell as Record<string, unknown>;
}

/** The mode the shell was launched with (`debug.rc.mode` on Android, `--mode` under Node). */
export function readMode(defaultMode: string): string {
  const mode = shellGlobal().mode;
  return typeof mode === "string" && mode ? mode : defaultMode;
}

export const hasShell = (): boolean => typeof g.__rcHost === "object" && g.__rcHost !== null;

export const round = (n: number, d = 3): number => Number(n.toFixed(d));

/** One JSON result line per step, the shape the pipeline's runner reads (`step: "done"` with `pass` ends a check). */
export function emit(step: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ step, host: hostName(), shell: hasShell(), ...fields }));
}

/** Settle a promise: drain microtasks and advance the virtual clock until it resolves (bounded). */
export async function settle<T>(p: Promise<T>, turns = 4000): Promise<T> {
  let settled = false;
  let error: unknown;
  let value: T | undefined;
  p.then(
    (v) => {
      settled = true;
      value = v;
    },
    (e) => {
      settled = true;
      error = e;
    },
  );
  for (let i = 0; i < turns && !settled; i += 1) {
    await Promise.resolve();
    virtualClock.advance(10);
  }
  if (!settled) throw new Error("the promise did not settle");
  if (error !== undefined) throw error;
  return value as T;
}
