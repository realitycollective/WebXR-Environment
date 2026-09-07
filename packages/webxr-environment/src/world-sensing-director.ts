/**
 * The world-sensing director: ask for what the room can tell you, then read it.
 *
 * ---------------------------------------------------------------------------
 * SAME SHAPE AS THE ENVIRONMENT DIRECTOR, POINTING THE OTHER WAY
 * ---------------------------------------------------------------------------
 * It owns no loop (`update(deltaMs)` is called by the host), it never touches a
 * session, and it holds the one copy of the truth so that two features cannot
 * disagree about how many tables there are. What it does NOT do is push a
 * description outwards: everything here arrives from the port and is read by
 * the app.
 *
 * ---------------------------------------------------------------------------
 * FULL SETS IN, DIFFS OUT
 * ---------------------------------------------------------------------------
 * A port hands over the WHOLE set of planes (or meshes, or anchors) it can
 * currently see, because that is the shape every host reports and because a
 * port that tried to diff would be four ports each diffing differently. The
 * director does the diffing once, by id, and emits `added` / `updated` /
 * `removed`. That is what an app needs: spawn something on a new table, drop it
 * when the table goes.
 *
 * An app that just wants a list ignores the change events and calls `planes()`.
 */
import type { SensingListener, SensingReport } from "./sensing.js";
import { unsupported } from "./sensing.js";
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  WorldAnchor,
  WorldChange,
  WorldDetectionSpec,
  WorldFeature,
  WorldHit,
  WorldMesh,
  WorldPlane,
  WorldPose,
} from "./world-sensing.js";
import { ALL_WORLD_DETECTION, resolveWorldDetection, worldEntryChanged } from "./world-sensing.js";

/** What a port is handed so it can report what the room looks like. */
export interface WorldSensingPortHost {
  /** The whole current set. Anything absent is treated as gone. */
  planes(planes: readonly WorldPlane[]): void;
  meshes(meshes: readonly WorldMesh[]): void;
  anchors(anchors: readonly WorldAnchor[]): void;
  /** The current answers for one standing hit-test request. */
  hits(sourceId: string, hits: readonly WorldHit[]): void;
  report(report: SensingReport): void;
}

/**
 * What an adapter implements. Everything except `observe` is optional, because
 * every host has a different subset and a missing method is reported rather
 * than thrown.
 */
export interface WorldSensingPort {
  observe(host: WorldSensingPortHost): (() => void) | void;
  /** Turn detection on or off. `null` means stop everything. */
  setDetection?(detection: ResolvedWorldDetection | null): void;
  startHitTest?(request: HitTestRequest): void;
  stopHitTest?(id: string): void;
  /**
   * Ask the runtime to remember a point. Resolves to the anchor's id, or null
   * when the runtime refused. Anchors then arrive through `host.anchors` like
   * any other, so an app can treat its own and the system's the same way.
   */
  createAnchor?(pose: WorldPose): Promise<string | null>;
  removeAnchor?(id: string): void;
  /** Called from the director's `update`; this is where a port polls its host. */
  update?(deltaMs: number): void;
  dispose?(): void;
}

export interface WorldSensingDirectorOptions {
  /** Start detecting immediately. Default: nothing is on. */
  readonly detection?: WorldDetectionSpec | boolean;
}

export type WorldChangeListener = (change: WorldChange) => void;

type Registry<T extends { id: string }> = Map<string, T>;

export class WorldSensingDirector {
  readonly #port: WorldSensingPort;
  readonly #planes: Registry<WorldPlane> = new Map();
  readonly #meshes: Registry<WorldMesh> = new Map();
  readonly #anchors: Registry<WorldAnchor> = new Map();
  readonly #hits = new Map<string, readonly WorldHit[]>();
  readonly #requests = new Map<string, HitTestRequest>();
  readonly #sensing = new Map<WorldFeature, SensingReport>();
  readonly #changeListeners = new Set<WorldChangeListener>();
  readonly #sensingListeners = new Set<SensingListener>();

  #detection: ResolvedWorldDetection | null = null;
  #unobserve: (() => void) | undefined;
  #disposed = false;

  constructor(port: WorldSensingPort, options: WorldSensingDirectorOptions = {}) {
    this.#port = port;
    const stop = port.observe(this.#host());
    if (typeof stop === "function") this.#unobserve = stop;
    if (options.detection !== undefined) this.setDetection(options.detection);
  }

  /** What is being detected, or `null` when nothing was asked for. */
  get detection(): ResolvedWorldDetection | null {
    return this.#detection;
  }

  /**
   * Ask for detection. `true` turns everything on, `false` or `null` stops.
   *
   * Turning a feature off drops what was found through it, and the change
   * event says so - an app that spawned content on those planes gets told to
   * clean it up rather than being left holding ids nothing will ever update.
   */
  setDetection(detection: WorldDetectionSpec | boolean | null): void {
    this.#assertLive();
    const next =
      detection === null || detection === false
        ? null
        : detection === true
          ? ALL_WORLD_DETECTION
          : resolveWorldDetection(detection);
    if (sameDetection(this.#detection, next)) return;
    this.#detection = next;

    if (this.#port.setDetection === undefined) {
      for (const feature of ["planes", "meshes", "anchors"] as const) {
        if (next === null || next[feature]) {
          this.#report(unsupported(feature, "this adapter cannot detect the room"));
        }
      }
      return;
    }
    this.#port.setDetection(next);
    // Anything switched off stops existing, now rather than at the next flush.
    if (next === null || !next.planes) this.#replace("planes", this.#planes, []);
    if (next === null || !next.meshes) this.#replace("meshes", this.#meshes, []);
    if (next === null || !next.anchors) this.#replace("anchors", this.#anchors, []);
  }

  planes(): readonly WorldPlane[] {
    return [...this.#planes.values()];
  }

  meshes(): readonly WorldMesh[] {
    return [...this.#meshes.values()];
  }

  anchors(): readonly WorldAnchor[] {
    return [...this.#anchors.values()];
  }

  /**
   * Planes carrying a label, matched without case. The host's vocabulary, not
   * ours: an unknown label is a string to log, not an error.
   */
  planesLabelled(label: string): readonly WorldPlane[] {
    const wanted = label.toLowerCase();
    return this.planes().filter((plane) => plane.label === wanted);
  }

  /**
   * The same for meshes, and not a nicety: a wall arrives as a detected MESH
   * as often as a plane, so an app looking for one needs both. Having the
   * helper on one side only would also hide that the matching is
   * case-insensitive, and a hand-written `=== "Wall"` returns an empty array
   * with nothing to explain it.
   */
  meshesLabelled(label: string): readonly WorldMesh[] {
    const wanted = label.toLowerCase();
    return this.meshes().filter((mesh) => mesh.label === wanted);
  }

  /** The latest answers for a standing request, or every answer with no id. */
  hits(sourceId?: string): readonly WorldHit[] {
    if (sourceId !== undefined) return this.#hits.get(sourceId) ?? [];
    return [...this.#hits.values()].flat();
  }

  /**
   * Start a standing hit test. Repeating an id replaces the request, which is
   * what an app aiming from a moving hand wants: one source, not one per frame.
   */
  startHitTest(request: HitTestRequest): void {
    this.#assertLive();
    if (this.#port.startHitTest === undefined) {
      this.#report(unsupported("hitTest", "this adapter has no hit test"));
      return;
    }
    if (this.#requests.has(request.id)) this.#port.stopHitTest?.(request.id);
    this.#requests.set(request.id, request);
    this.#port.startHitTest(request);
  }

  stopHitTest(id: string): void {
    this.#assertLive();
    if (!this.#requests.delete(id)) return;
    this.#hits.delete(id);
    this.#port.stopHitTest?.(id);
  }

  /**
   * Ask the runtime to remember a point in the room.
   *
   * Resolves to the new anchor's id, or `null` when the host cannot - which is
   * a normal answer, not an error: anchors are refused when tracking is poor,
   * and an app that treats that as a crash is an app that crashes in a dark
   * room.
   */
  async createAnchor(pose: WorldPose): Promise<string | null> {
    this.#assertLive();
    if (this.#port.createAnchor === undefined) {
      this.#report(unsupported("anchors", "this adapter cannot create anchors"));
      return null;
    }
    // Making an anchor and not watching anchors is a trap, not a choice: the
    // app would hold an id nothing ever updates, and the content it pinned
    // would never move again. Creating one turns detection on, and says so,
    // rather than handing back a dead id.
    if (this.#detection === null || !this.#detection.anchors) {
      this.setDetection({
        planes: this.#detection?.planes ?? false,
        meshes: this.#detection?.meshes ?? false,
        anchors: true,
      });
      this.#report({
        feature: "anchors",
        state: "pending",
        detail: "anchor detection was turned on so the anchor you created can be tracked",
      });
    }
    return await this.#port.createAnchor(pose);
  }

  removeAnchor(id: string): void {
    this.#assertLive();
    this.#port.removeAnchor?.(id);
  }

  /** The last thing the adapter said about a world feature. */
  getSensing(feature: WorldFeature): SensingReport {
    return this.#sensing.get(feature) ?? unsupported(feature);
  }

  onSensing(listener: SensingListener): () => void {
    this.#sensingListeners.add(listener);
    return () => {
      this.#sensingListeners.delete(listener);
    };
  }

  /** Subscribe to what appeared, moved and went away. Returns the unsubscribe. */
  onChange(listener: WorldChangeListener): () => void {
    this.#changeListeners.add(listener);
    return () => {
      this.#changeListeners.delete(listener);
    };
  }

  update(deltaMs: number): void {
    if (this.#disposed) return;
    this.#port.update?.(deltaMs);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of this.#requests.keys()) this.#port.stopHitTest?.(id);
    this.#requests.clear();
    this.#hits.clear();
    this.#changeListeners.clear();
    this.#sensingListeners.clear();
    this.#unobserve?.();
    this.#unobserve = undefined;
    this.#port.dispose?.();
  }

  #host(): WorldSensingPortHost {
    return {
      planes: (planes) => {
        this.#replace("planes", this.#planes, planes);
      },
      meshes: (meshes) => {
        this.#replace("meshes", this.#meshes, meshes);
      },
      anchors: (anchors) => {
        this.#replace("anchors", this.#anchors, anchors);
      },
      hits: (sourceId, hits) => {
        if (this.#disposed) return;
        // An answer to a question nobody asked is dropped rather than kept:
        // it can only come from a source the app already stopped.
        if (!this.#requests.has(sourceId)) return;
        this.#hits.set(sourceId, hits);
      },
      report: (report) => {
        this.#report(report);
      },
    };
  }

  #replace<T extends { id: string }>(
    feature: WorldChange["feature"],
    registry: Registry<T>,
    next: readonly T[],
  ): void {
    if (this.#disposed) return;
    const added: string[] = [];
    const updated: string[] = [];
    const seen = new Set<string>();

    for (const entry of next) {
      seen.add(entry.id);
      const previous = registry.get(entry.id);
      if (previous === undefined) {
        added.push(entry.id);
      } else if (
        worldEntryChanged(
          previous as unknown as WorldPlane,
          entry as unknown as WorldPlane,
        )
      ) {
        updated.push(entry.id);
      }
      registry.set(entry.id, entry);
    }

    const removed: string[] = [];
    for (const id of registry.keys()) {
      if (seen.has(id)) continue;
      removed.push(id);
    }
    for (const id of removed) registry.delete(id);

    if (added.length === 0 && updated.length === 0 && removed.length === 0) return;
    const change: WorldChange = { feature, added, updated, removed };
    for (const listener of this.#changeListeners) listener(change);
  }

  #report(report: SensingReport): void {
    if (this.#disposed) return;
    const feature = report.feature as WorldFeature;
    const previous = this.#sensing.get(feature);
    if (
      previous !== undefined &&
      previous.state === report.state &&
      previous.detail === report.detail
    ) {
      return;
    }
    this.#sensing.set(feature, report);
    for (const listener of this.#sensingListeners) listener(report);
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new Error("[webxr-environment] the world sensing director has been disposed");
    }
  }
}

function sameDetection(
  a: ResolvedWorldDetection | null,
  b: ResolvedWorldDetection | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.planes === b.planes && a.meshes === b.meshes && a.anchors === b.anchors;
}
