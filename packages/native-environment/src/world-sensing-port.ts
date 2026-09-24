/**
 * `WorldSensingPort` for a native host.
 *
 * ---------------------------------------------------------------------------
 * THE SAME "GROW ONLY WHAT EXISTS" SHAPE AS THE ENVIRONMENT PORT
 * ---------------------------------------------------------------------------
 * Every member of `WorldSensingPort` except `observe` is optional on the
 * interface itself, because `WorldSensingDirector` already reports
 * `unsupported` the moment an app asks for a feature the port does not have -
 * see its `setDetection`, `startHitTest` and `createAnchor`. So this port
 * grows `setDetection` / `startHitTest` / `stopHitTest` / `createAnchor` /
 * `removeAnchor` one at a time, exactly when `sensing` implements the matching
 * member, and leaves the rest off itself. A host with no `sensing` slice at
 * all - which the contract treats as a normal, supported shape, not an error -
 * grows none of them, and every call the app makes is reported `unsupported`
 * by the director, which is what "the port reports unsupported" in
 * `NATIVE_HOST_CONTRACT.md` means in practice: the reporting already exists
 * one layer up, and this port's job is only to be honestly absent.
 *
 * `update` is not implemented: every other adapter's world-sensing port polls
 * because its host (a `renderer`, an ECS `world`) hands back a frame's worth
 * of state on demand. A native host has no such frame to poll - it PUSHES
 * through the five `on*` callbacks below - so there is nothing here for a tick
 * to do.
 */
import type {
  HitTestRequest,
  ResolvedWorldDetection,
  WorldPose,
  WorldSensingPort,
  WorldSensingPortHost,
} from "@realitycollective/webxr-environment";
import type { NativeSensingHost } from "./native-types.js";
import { getSensingHost } from "./native-types.js";

export class NativeWorldSensingPort implements WorldSensingPort {
  readonly #host: NativeSensingHost | undefined;

  constructor(host?: NativeSensingHost) {
    this.#host = getSensingHost(host);
    const sensing = this.#host;
    if (sensing?.setDetection !== undefined) {
      const setDetection = sensing.setDetection;
      this.setDetection = (detection: ResolvedWorldDetection | null) => setDetection(detection);
    }
    if (sensing?.startHitTest !== undefined) {
      const startHitTest = sensing.startHitTest;
      this.startHitTest = (request: HitTestRequest) => startHitTest(request);
    }
    if (sensing?.stopHitTest !== undefined) {
      const stopHitTest = sensing.stopHitTest;
      this.stopHitTest = (id: string) => stopHitTest(id);
    }
    if (sensing?.createAnchor !== undefined) {
      const createAnchor = sensing.createAnchor;
      this.createAnchor = (pose: WorldPose) => createAnchor(pose);
    }
    if (sensing?.removeAnchor !== undefined) {
      const removeAnchor = sensing.removeAnchor;
      this.removeAnchor = (id: string) => removeAnchor(id);
    }
  }

  /** Present only when the host implements `setDetection`. */
  setDetection?: (detection: ResolvedWorldDetection | null) => void;
  /** Present only when the host implements `startHitTest`. */
  startHitTest?: (request: HitTestRequest) => void;
  /** Present only when the host implements `stopHitTest`. */
  stopHitTest?: (id: string) => void;
  /** Present only when the host implements `createAnchor`. */
  createAnchor?: (pose: WorldPose) => Promise<string | null>;
  /** Present only when the host implements `removeAnchor`. */
  removeAnchor?: (id: string) => void;

  /**
   * Wire whichever of the five push channels the host has.
   *
   * A host with no `sensing` slice at all wires nothing and returns a no-op
   * unsubscribe: there was nothing to subscribe to, so there is nothing to
   * undo.
   */
  observe(host: WorldSensingPortHost): () => void {
    const sensing = this.#host;
    if (sensing === undefined) return () => {};

    const unsubscribers: Array<() => void> = [];
    if (sensing.onPlanes !== undefined) {
      unsubscribers.push(sensing.onPlanes((planes) => host.planes(planes)));
    }
    if (sensing.onMeshes !== undefined) {
      unsubscribers.push(sensing.onMeshes((meshes) => host.meshes(meshes)));
    }
    if (sensing.onAnchors !== undefined) {
      unsubscribers.push(sensing.onAnchors((anchors) => host.anchors(anchors)));
    }
    if (sensing.onHits !== undefined) {
      unsubscribers.push(sensing.onHits((sourceId, hits) => host.hits(sourceId, hits)));
    }
    if (sensing.onSensingReport !== undefined) {
      unsubscribers.push(sensing.onSensingReport((report) => host.report(report)));
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }
}
