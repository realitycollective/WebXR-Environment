/**
 * The inbound seam: what an adapter tells the core, rather than the other way
 * round.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Everything else in this package runs one way. The app describes a world, the
 * director resolves it, the port applies it. That was right while every slot
 * was a decision the app had already made: there is nothing to report about a
 * sky, because the app can see it.
 *
 * Sensor-backed features are not like that. Depth occlusion is granted or
 * refused by the session, light estimation starts and stops as the runtime
 * gains and loses confidence, and both of them fail to a scene that looks
 * completely normal. Without a way back, "occlusion is on" and "occlusion is
 * doing nothing" are the same picture, and the only way to tell them apart is
 * a headset and a guess.
 *
 * So there is exactly one inbound path, and it carries two kinds of message:
 *
 * - a REPORT: this feature is unsupported, unavailable, pending or active, and
 *   here is a sentence saying why. Never parsed, never switched on, shown to a
 *   human or logged.
 * - an ESTIMATE: the host measured the real world's lighting, expressed in the
 *   same spec types the app already uses.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT KEEPS IT HONEST
 * ---------------------------------------------------------------------------
 * A report never changes what the app asked for. It changes what the app can
 * be TOLD. An estimate is the one exception, and it is an explicit one: the
 * app opts in with `setLightEstimation`, and turning it off restores the
 * requested environment with nothing to remember.
 *
 * There is still no polling, no loop and no engine type here. An adapter calls
 * these methods when its host tells it something; the director fans out.
 */
import type { AmbientLightSpec, IblSpec, KeyLightSpec } from "./environment.js";

/**
 * The sensor-backed features an adapter can report on.
 *
 * Deliberately a closed set rather than a string: a readout that switches on
 * an open-ended name is a readout that silently stops covering half of them.
 */
export const SENSING_FEATURES = [
  "occlusion",
  "lightEstimation",
  "depthTexture",
  // The world features, reported through the same vocabulary by the SEPARATE
  // world-sensing director. One list, so a readout covers everything a host
  // was asked for; two directors, because describing a sky and being told
  // about a table are different jobs with different consumers.
  "planes",
  "meshes",
  "anchors",
  "hitTest",
] as const;

export type SensingFeature = (typeof SENSING_FEATURES)[number];

/**
 * How a feature is doing, in the order things usually go wrong:
 *
 * - `unsupported` - this host cannot do it at all. IWSDK and light estimation.
 * - `unavailable` - the host can, but this session did not get it. The feature
 *   was not requested, or was refused, or was granted in a form this adapter
 *   cannot use.
 * - `pending` - asked for and accepted, nothing measured yet. Light estimation
 *   sits here until the runtime is confident; depth sits here for the frames
 *   before the first texture arrives.
 * - `active` - working right now.
 */
export type SensingState = "unsupported" | "unavailable" | "pending" | "active";

export interface SensingReport {
  readonly feature: SensingFeature;
  readonly state: SensingState;
  /**
   * Why, in a sentence, for a human. Never parsed and never switched on - if
   * code needs to branch on something, that something belongs in `state`.
   */
  readonly detail?: string;
}

/**
 * Lighting the host measured from the real world.
 *
 * Every member is one of the spec types the environment document already uses,
 * so an estimate needs no translation to be applied and no new shape to be
 * read. An omitted member means "the host did not measure this"; an explicit
 * `null` means "the host measured that there is none", which is the difference
 * between a runtime without a light probe and a genuinely dark room.
 */
export interface EstimatedLighting {
  readonly ambient?: AmbientLightSpec | null;
  readonly key?: KeyLightSpec | null;
  readonly ibl?: IblSpec | null;
}

/** What a port is handed so it can talk back. Implemented by the director. */
export interface EnvironmentPortHost {
  /** State changed for one feature. Cheap to call; identical reports are dropped. */
  report(report: SensingReport): void;
  /**
   * New measured lighting, or `null` when estimation stopped and the app's own
   * environment should take over again.
   */
  estimate(lighting: EstimatedLighting | null): void;
}

export type SensingListener = (report: SensingReport) => void;

/** The report a feature has before any adapter has said otherwise. */
export function unsupported(feature: SensingFeature, detail?: string): SensingReport {
  return detail === undefined ? { feature, state: "unsupported" } : { feature, state: "unsupported", detail };
}
