/**
 * The shared scene management conformance suite, shipped as data rather than
 * as tests, in the same runner-free shape as `contract-cases.ts`.
 *
 * Unlike the port suites, these cases run the REAL `SceneManager` over the
 * platform's real `ScenePort`, because the rules are what every platform
 * promises and the port is where a platform can break them: a port that
 * leaves a hidden scene hit-testable, forgets an instance on destroy, or takes
 * a detached node down with its scene fails here.
 *
 * A platform's test builds the fixture scenes below with its own objects -
 * three.js meshes, IWSDK entities, a native app's nodes - and hands the suite
 * an inspector that answers from the host itself:
 *
 * ```ts
 * for (const contractCase of sceneManagerContractCases()) {
 *   it(contractCase.name, () => contractCase.run({ create: (fixtures) => makeHost(fixtures) }));
 * }
 * ```
 *
 * `create` runs once per case, so each case gets a host of its own.
 */
import type { EnvironmentSpec, Vec3 } from "./environment.js";
import type { SkySpec } from "./environment.js";
import { EnvironmentDirector } from "./environment-director.js";
import type { EnvironmentPort } from "./ports.js";
import { deepEquals } from "./equality.js";
import type { WorldPose } from "./world-sensing.js";
import type { SceneDefinition, ScenePort } from "./scenes.js";
import { PERSISTENT_SCENE_ID } from "./scenes.js";
import type { SceneManagerOptions } from "./scene-manager.js";
import { SceneManager } from "./scene-manager.js";

/** One node of a fixture scene: an id, and where it sits in world space. */
export interface SceneContractNode {
  readonly id: string;
  readonly position: Vec3;
}

/** What a fixture `src` builds. */
export interface SceneContractScene {
  /** Build one host object per entry, each hit-testable, at its position. Ids may repeat on purpose. */
  readonly nodes: readonly SceneContractNode[];
  /** Microtask turns the loader waits before it resolves. Default 0. */
  readonly turns?: number;
  /** Reject instead of building, leaving nothing behind. */
  readonly fail?: boolean;
}

/** Everything a platform's contract host must be able to build. */
export interface SceneContractFixtures {
  /** By `src`. */
  readonly scenes: Readonly<Record<string, SceneContractScene>>;
  /** Asset names `instantiate` must accept. Each builds one hit-testable host object. */
  readonly assets: readonly string[];
}

/** Answers about a node from the host itself, never from the manager. */
export interface SceneContractInspector<N = unknown> {
  /** The node is still on the host: not destroyed. */
  exists(node: N): boolean;
  /** The host would render the node now. */
  isShown(node: N): boolean;
  /** The host's own hit testing would find the node now. */
  isHitTestable(node: N): boolean;
  /** Where the node is, in world space. */
  worldPosition(node: N): Vec3;
  /** How many objects the port has created on the host and not yet removed. */
  liveCount(): number;
}

/** A port over a fresh host that builds the fixtures, and the inspector for that host. */
export interface SceneContractHost<S = unknown, N = unknown> {
  readonly port: ScenePort<S, N>;
  readonly inspect: SceneContractInspector<N>;
}

/** What a scene manager contract case is handed. */
export interface SceneManagerContractSubject<S = unknown, N = unknown> {
  create(fixtures: SceneContractFixtures): SceneContractHost<S, N>;
  /**
   * Build the manager under test. Default `new SceneManager(port, options)`.
   * The suite's own tests pass a manager built to break a rule here.
   */
  createManager?(port: ScenePort<S, N>, options: SceneManagerOptions): SceneManager<S, N>;
}

/** One check the scene manager and a platform's port must pass together. */
export interface SceneManagerContractCase {
  name: string;
  run(subject: SceneManagerContractSubject): Promise<void>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RED: SkySpec = { kind: "solid", colour: [0.8, 0.1, 0.1] };
const BLUE: SkySpec = { kind: "solid", colour: [0.1, 0.1, 0.8] };
const GREY: SkySpec = { kind: "solid", colour: [0.5, 0.5, 0.5] };

/** Every node sits at its own x, so a downward probe at one node cannot find another. */
export const SCENE_CONTRACT_FIXTURES: SceneContractFixtures = {
  scenes: {
    "contract://lobby": {
      nodes: [
        { id: "hud", position: [-3, 1.5, -1] },
        { id: "floor", position: [-2, 0, -1] },
      ],
    },
    "contract://court": {
      nodes: [
        { id: "tee", position: [-1, 1, -1] },
        { id: "net", position: [0, 1, -1] },
      ],
    },
    "contract://level": { nodes: [{ id: "stage", position: [1, 0, -1] }] },
    "contract://plain": { nodes: [{ id: "rock", position: [2, 0, -1] }] },
    "contract://slow": { nodes: [{ id: "slow-node", position: [3, 0, -1] }], turns: 12 },
    "contract://fast": { nodes: [{ id: "fast-node", position: [4, 0, -1] }] },
    "contract://broken": { nodes: [], fail: true },
    "contract://repeat": {
      nodes: [
        { id: "twin", position: [5, 0, -1] },
        { id: "twin", position: [6, 0, -1] },
      ],
    },
  },
  assets: ["ball"],
};

const LOBBY_ENVIRONMENT: EnvironmentSpec = { sky: RED };
const COURT_ENVIRONMENT: EnvironmentSpec = { sky: BLUE };

const SCENES: readonly SceneDefinition[] = [
  { id: "lobby", src: "contract://lobby", environment: LOBBY_ENVIRONMENT },
  { id: "court", src: "contract://court", environment: COURT_ENVIRONMENT },
  { id: "level", src: "contract://level" },
  { id: "plain", src: "contract://plain" },
  { id: "slow", src: "contract://slow" },
  { id: "fast", src: "contract://fast" },
  { id: "broken", src: "contract://broken" },
  { id: "repeat", src: "contract://repeat" },
];

const SPAWN_POSE: WorldPose = { position: [7, 1, -2], orientation: [0, 0, 0, 1] };
const EPS = 1e-3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assert(
    deepEquals(actual, expected),
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

function assertClose(actual: Vec3, expected: Vec3, label: string): void {
  const close = actual.every((value, index) => Math.abs(value - (expected[index] as number)) <= EPS);
  assert(close, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function assertRejects(promise: Promise<unknown>, label: string): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`${label} must reject, it resolved`);
}

/** A port that accepts every slot and does nothing, so a real director can run. */
function silentEnvironmentPort(): EnvironmentPort {
  return {
    applySky() {},
    applyFog() {},
    applyAmbient() {},
    applyKeyLight() {},
    applyIbl() {},
  };
}

interface Rig {
  readonly manager: SceneManager;
  readonly inspect: SceneContractInspector;
  readonly baseline: number;
  node(sceneId: string, nodeId: string): unknown;
  ids(): string[];
}

function rig(subject: SceneManagerContractSubject, options: SceneManagerOptions = {}): Rig {
  const { port, inspect } = subject.create(SCENE_CONTRACT_FIXTURES);
  const baseline = inspect.liveCount();
  const manager = subject.createManager?.(port, options) ?? new SceneManager(port, options);
  manager.register(SCENES);
  return {
    manager,
    inspect,
    baseline,
    node(sceneId, nodeId) {
      const found = manager.getNode(sceneId, nodeId);
      assert(found !== null, `getNode("${sceneId}", "${nodeId}") must find the node`);
      return found;
    },
    ids() {
      return manager.loaded().map((scene) => scene.id);
    },
  };
}

function assertShown(r: Rig, node: unknown, label: string): void {
  assert(r.inspect.exists(node), `${label} must still exist on the host`);
  assert(r.inspect.isShown(node), `${label} must be shown`);
  assert(r.inspect.isHitTestable(node), `${label} must be hit-testable`);
}

function assertGone(r: Rig, node: unknown, label: string): void {
  assert(!r.inspect.exists(node), `${label} must be gone from the host`);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

/**
 * The shared scene management conformance suite. See the file comment for how
 * a platform runs it.
 */
export function sceneManagerContractCases(): readonly SceneManagerContractCase[] {
  return SCENE_CASES;
}

const SCENE_CASES: readonly SceneManagerContractCase[] = [
  {
    name: "the scene list keeps registration order, and a load of an id not in the list rejects",
    async run(subject) {
      const r = rig(subject);
      assertEqual(
        r.manager.list().map((def) => def.id),
        SCENES.map((def) => def.id),
        "list()",
      );
      await assertRejects(r.manager.load("no-such-scene"), 'load("no-such-scene")');
      assertEqual(r.ids(), [], "loaded() after a rejected load");
      r.manager.dispose();
    },
  },
  {
    name: "a single load unloads every loaded scene, then loads; unloaded events fire before the loaded event",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive" });
      const hud = r.node("lobby", "hud");
      const tee = r.node("court", "tee");
      const events: string[] = [];
      r.manager.onSceneUnloaded((id) => events.push(`unloaded:${id}`));
      r.manager.onSceneLoaded((id) => events.push(`loaded:${id}`));
      await r.manager.load("level");
      assertEqual(r.ids(), ["level"], "loaded() after a single load");
      assertEqual([...events].sort(), ["loaded:level", "unloaded:court", "unloaded:lobby"], "events");
      assertEqual(events.at(-1), "loaded:level", "the last event");
      assertGone(r, hud, "lobby/hud");
      assertGone(r, tee, "court/tee");
      assertShown(r, r.node("level", "stage"), "level/stage");
      r.manager.dispose();
    },
  },
  {
    name: "a single load keeps persistent nodes, shown and where they were",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const hud = r.node("lobby", "hud");
      const floor = r.node("lobby", "floor");
      const before = r.inspect.worldPosition(hud);
      r.manager.makePersistent("lobby", "hud");
      await r.manager.load("level");
      assertEqual(r.ids(), ["level"], "loaded() after a single load");
      assert(r.manager.getNode(PERSISTENT_SCENE_ID, "hud") === hud, "the persistent node keeps its host node");
      assertShown(r, hud, "persistent hud");
      assertClose(r.inspect.worldPosition(hud), before, "persistent hud world position");
      assertGone(r, floor, "lobby/floor");
      r.manager.dispose();
    },
  },
  {
    name: "an additive load adds to the top of the stack and changes nothing else",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const hud = r.node("lobby", "hud");
      await r.manager.load("court", { mode: "additive" });
      assertEqual(
        r.manager.loaded(),
        [
          { id: "lobby", state: "loaded", order: 0 },
          { id: "court", state: "loaded", order: 1 },
        ],
        "loaded()",
      );
      assertEqual(r.manager.getActiveScene(), "lobby", "getActiveScene()");
      assertShown(r, hud, "lobby/hud");
      assertShown(r, r.node("court", "tee"), "court/tee");
      r.manager.dispose();
    },
  },
  {
    name: "unload removes any scene in the stack, and the rest keep their order",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive" });
      await r.manager.load("level", { mode: "additive" });
      const tee = r.node("court", "tee");
      await r.manager.unload("court");
      assertEqual(
        r.manager.loaded(),
        [
          { id: "lobby", state: "loaded", order: 0 },
          { id: "level", state: "loaded", order: 1 },
        ],
        "loaded() after unloading the middle scene",
      );
      assertGone(r, tee, "court/tee");
      assertShown(r, r.node("lobby", "hud"), "lobby/hud");
      assertShown(r, r.node("level", "stage"), "level/stage");
      r.manager.dispose();
    },
  },
  {
    name: "an unloaded scene takes its instances with it, and leaves its persistent nodes",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const id = r.manager.instantiate("ball", SPAWN_POSE);
      const ball = r.node("lobby", id);
      const floor = r.node("lobby", "floor");
      r.manager.makePersistent("lobby", "floor");
      await r.manager.unload("lobby");
      assertGone(r, ball, "the instance");
      assert(r.manager.getNode("lobby", id) === null, "an unloaded scene's instance must not resolve");
      assertShown(r, floor, "persistent floor");
      r.manager.dispose();
    },
  },
  {
    name: "instantiate puts a new instance in the active scene, at its pose, when no scene is named",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive" });
      r.manager.setActiveScene("court");
      const id = r.manager.instantiate("ball", SPAWN_POSE);
      const ball = r.node("court", id);
      assert(r.manager.getNode("lobby", id) === null, "the instance must not belong to the other scene");
      assertShown(r, ball, "the instance");
      assertClose(r.inspect.worldPosition(ball), SPAWN_POSE.position, "the instance's world position");
      r.manager.destroy(id);
      assertGone(r, ball, "a destroyed instance");
      r.manager.dispose();
    },
  },
  {
    name: "the active scene's environment drives the director, with the configured transition",
    async run(subject) {
      const environment = new EnvironmentDirector(silentEnvironmentPort(), { initial: { sky: GREY } });
      const r = rig(subject, { environment, transition: { durationMs: 1000 } });
      await r.manager.load("lobby");
      assert(environment.transitioning, "making a scene active must start the environment transition");
      environment.update(1000);
      assertEqual(environment.current.sky, RED, "sky after the lobby transition");
      await r.manager.load("court", { mode: "additive", makeActive: true });
      environment.update(1000);
      assertEqual(environment.current.sky, BLUE, "sky after the court became active");
      await r.manager.load("plain", { mode: "additive", makeActive: true });
      environment.update(1000);
      assertEqual(environment.current.sky, BLUE, "a scene without an environment leaves it as it is");
      r.manager.dispose();
      environment.dispose();
    },
  },
  {
    name: "there is at most one active scene; unloading it makes the top shown scene active, or none",
    async run(subject) {
      const r = rig(subject);
      const changes: string[] = [];
      r.manager.onActiveSceneChanged((from, to) => changes.push(`${String(from)}>${String(to)}`));
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive" });
      await r.manager.load("level", { mode: "additive", activate: false });
      r.manager.setActiveScene("court");
      await r.manager.unload("court");
      assertEqual(r.manager.getActiveScene(), "lobby", "active after unloading the active scene");
      await r.manager.unload("lobby");
      assertEqual(r.manager.getActiveScene(), null, "active once no shown scene is left");
      assertEqual(changes, ["null>lobby", "lobby>court", "court>lobby", "lobby>null"], "active scene changes");
      r.manager.dispose();
    },
  },
  {
    name: "a preloaded scene is built but neither shown nor hit-testable, and its bindings wait, until activate",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive", activate: false });
      assert(r.manager.isLoaded("court"), "a preloaded scene counts as loaded");
      assertEqual(r.manager.loaded().at(-1)?.state, "preloaded", "the preloaded scene's state");
      const tee = r.node("court", "tee");
      assert(r.inspect.exists(tee), "a preloaded scene must be built");
      assert(!r.inspect.isShown(tee), "a preloaded scene must not be shown");
      assert(!r.inspect.isHitTestable(tee), "a preloaded scene must not be hit-testable");
      let bound = 0;
      r.manager.bindNode("court", "tee", () => {
        bound += 1;
      });
      assertEqual(bound, 0, "binds run before activate");
      r.manager.activate("court");
      assertShown(r, tee, "court/tee after activate");
      assertEqual(bound, 1, "binds run by activate");
      assertEqual(r.manager.getActiveScene(), "lobby", "an activated additive scene leaves the active scene");
      r.manager.dispose();
    },
  },
  {
    name: "a preloaded single load leaves the other scenes until it is activated, then replaces them",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const hud = r.node("lobby", "hud");
      await r.manager.load("level", { activate: false });
      assertEqual(r.ids(), ["lobby", "level"], "loaded() while preloaded");
      assertShown(r, hud, "lobby/hud while the next scene preloads");
      r.manager.activate("level");
      assertEqual(r.ids(), ["level"], "loaded() after activate");
      assertEqual(r.manager.getActiveScene(), "level", "getActiveScene() after activate");
      assertGone(r, hud, "lobby/hud");
      assertShown(r, r.node("level", "stage"), "level/stage");
      r.manager.dispose();
    },
  },
  {
    name: "loads and unloads run one at a time, in call order",
    async run(subject) {
      const r = rig(subject);
      const events: string[] = [];
      r.manager.onSceneLoaded((id) => events.push(`loaded:${id}`));
      r.manager.onSceneUnloaded((id) => events.push(`unloaded:${id}`));
      const slow = r.manager.load("slow", { mode: "additive" });
      const fast = r.manager.load("fast", { mode: "additive" });
      const gone = r.manager.unload("slow");
      await Promise.all([slow, fast, gone]);
      assertEqual(events, ["loaded:slow", "loaded:fast", "unloaded:slow"], "event order");
      assertEqual(r.ids(), ["fast"], "loaded()");
      r.manager.dispose();
    },
  },
  {
    name: "a second load of a scene already loading or loaded returns the same promise",
    async run(subject) {
      const r = rig(subject);
      const first = r.manager.load("lobby");
      const whileLoading = r.manager.load("lobby");
      assert(whileLoading === first, "a load of a scene still loading must return the same promise");
      await first;
      const count = r.inspect.liveCount();
      const whenLoaded = r.manager.load("lobby");
      assert(whenLoaded === first, "a load of a loaded scene must return the same promise");
      await whenLoaded;
      assertEqual(r.inspect.liveCount(), count, "objects on the host after the repeat load");
      assertEqual(r.ids(), ["lobby"], "loaded()");
      r.manager.dispose();
    },
  },
  {
    name: "a scene that repeats a node id fails to load and leaves nothing behind",
    async run(subject) {
      const r = rig(subject);
      await assertRejects(r.manager.load("repeat", { mode: "additive" }), 'load("repeat")');
      assertEqual(r.ids(), [], "loaded()");
      assertEqual(r.inspect.liveCount(), r.baseline, "objects on the host");
      r.manager.dispose();
    },
  },
  {
    name: "a scene the host cannot build rejects, and the stack stays as it was",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const count = r.inspect.liveCount();
      await assertRejects(r.manager.load("broken", { mode: "additive" }), 'load("broken")');
      assertEqual(r.ids(), ["lobby"], "loaded()");
      assertEqual(r.inspect.liveCount(), count, "objects on the host");
      await r.manager.load("fast", { mode: "additive" });
      assertEqual(r.ids(), ["lobby", "fast"], "loaded() after a later load");
      r.manager.dispose();
    },
  },
  {
    name: "a bound node resolves to the host's node, and the binding is released when its scene unloads",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      let bound: unknown = null;
      let released = 0;
      const unbind = r.manager.bindNode("lobby", "hud", (node) => {
        bound = node;
        return () => {
          released += 1;
        };
      });
      assert(bound !== null && bound === r.node("lobby", "hud"), "the bound node must be getNode's node");
      assert(r.inspect.exists(bound), "the bound node must be on the host");
      await r.manager.unload("lobby");
      assertEqual(released, 1, "releases after unload");
      unbind();
      assertEqual(released, 1, "releases after a late unbind");
      r.manager.dispose();
    },
  },
  {
    name: "setNodeActive turns one node off and on again",
    async run(subject) {
      const r = rig(subject);
      await r.manager.load("lobby");
      const hud = r.node("lobby", "hud");
      const floor = r.node("lobby", "floor");
      r.manager.setNodeActive("lobby", "hud", false);
      assert(r.inspect.exists(hud), "an inactive node must still exist");
      assert(!r.inspect.isShown(hud), "an inactive node must not be shown");
      assert(!r.inspect.isHitTestable(hud), "an inactive node must not be hit-testable");
      assertShown(r, floor, "the other node");
      r.manager.setNodeActive("lobby", "hud", true);
      assertShown(r, hud, "the node after it is turned back on");
      r.manager.dispose();
    },
  },
  {
    name: "dispose leaves nothing on the host: no nodes, instances, bindings, listeners or environment overrides",
    async run(subject) {
      const environment = new EnvironmentDirector(silentEnvironmentPort(), { initial: { sky: GREY } });
      const base = environment.current;
      const r = rig(subject, { environment });
      let events = 0;
      r.manager.onSceneLoaded(() => (events += 1));
      await r.manager.load("lobby");
      await r.manager.load("court", { mode: "additive", makeActive: true });
      await r.manager.load("level", { mode: "additive", activate: false });
      r.manager.instantiate("ball", SPAWN_POSE);
      r.manager.makePersistent("lobby", "hud");
      let released = 0;
      r.manager.bindNode(PERSISTENT_SCENE_ID, "hud", () => () => (released += 1));
      r.manager.bindNode("court", "tee", () => () => (released += 1));
      const seen = events;
      r.manager.dispose();
      assertEqual(r.inspect.liveCount(), r.baseline, "objects on the host after dispose");
      assertEqual(released, 2, "bindings released by dispose");
      assertEqual(environment.current, base, "the environment after dispose");
      await assertRejects(r.manager.load("fast"), "a load after dispose");
      assertEqual(events, seen, "listener calls after dispose");
      r.manager.dispose();
      environment.dispose();
    },
  },
];
