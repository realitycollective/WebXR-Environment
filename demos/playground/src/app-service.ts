/**
 * The playground's one app service.
 *
 * Every Reality Collective demo shares this shape. The app reaches its
 * platform through the Service Framework, and the framework's runtime adapter
 * owns the frame tick. This file imports only the Service Framework core, so
 * the same class runs under the three.js, IWSDK, XR Blocks, Babylon.js and
 * native adapters. The engine objects (renderer, scene, camera and the
 * environment directors) stay in `main.ts` and reach this service only through
 * the `frame` closure.
 */
import {
  BaseService,
  createServiceToken,
  type AdapterCapabilities,
  type LifecycleContext,
  type RuntimeAdapter,
  type Unsubscribe,
} from "@realitycollective/service-framework";

export interface EnvironmentAppConfig {
  /** The platform's runtime adapter: capabilities, the session facet and the frames it owns or relays. */
  readonly adapter: RuntimeAdapter;
  /**
   * Per-frame work: tick the family bindings and draw. Called from `render()`
   * once per `renderTick`, with the frame's delta in SECONDS and the
   * scheduler's context, whose `deltaTime` and `timestamp` are milliseconds.
   */
  readonly frame: (deltaSeconds: number, context: LifecycleContext) => void;
  /** Where platform facts go: one line per fact, such as a capability change or a session state. */
  readonly report: (line: string) => void;
}

/** Reports the platform's capabilities and session state, and hands every frame to the page. */
export class EnvironmentAppService extends BaseService<EnvironmentAppConfig> {
  private readonly unsubscribes: Unsubscribe[] = [];

  public override start(): void {
    const { adapter, report } = this.serviceConfig;
    report(`capabilities ${describeCapabilities(adapter.getCapabilities())}`);
    this.unsubscribes.push(
      adapter.onCapabilitiesChange((capabilities) => report(`capabilities ${describeCapabilities(capabilities)}`)),
    );
    const session = adapter.session;
    if (session === undefined) {
      report("session facet: none on this host");
      return;
    }
    report(`session ${session.getState()}`);
    this.unsubscribes.push(session.onStateChange((state) => report(`session ${state}`)));
  }

  public override render(context: LifecycleContext): void {
    this.serviceConfig.frame(context.deltaTime / 1000, context);
  }

  public override destroy(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
  }
}

/** The token the playground's profile registers {@link EnvironmentAppService} under. */
export const ENVIRONMENT_APP_TOKEN = createServiceToken<EnvironmentAppService>("EnvironmentAppService");

function describeCapabilities(capabilities: AdapterCapabilities): string {
  return JSON.stringify(capabilities);
}
