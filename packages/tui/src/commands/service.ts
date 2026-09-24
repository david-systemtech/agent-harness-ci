import type { Clock, Runtime } from "@agent-harness/client-runtime";
import type { LocalService, ServiceOutcome } from "../platform/services.js";
import type { RuntimeHost } from "../runtime-host.js";
import { localEnvironment } from "../view.js";

/**
 * `y` on the service-down offer (docs/specs/tui.md, "First launch"): runs
 * the CLI's `service start` (`service install` first when no service is
 * installed), then waits for the environment to answer and hands over to
 * the runtime, which shows `starting` until `ready`. A local connection the
 * runtime lists is retried at once; one it never saw is found by a fresh
 * runtime once the environment is ready (`RuntimeHost.restart`).
 */

/** How often the environment's readiness is asked while it comes up, and for how long. Chosen defaults. */
export const READINESS_POLL_MS = 1000;
export const READINESS_WAIT_MS = 60_000;

const sleep = (clock: Clock, ms: number) => new Promise<void>((resolve) => clock.setTimeout(resolve, ms));

export const startLocalEnvironment = async (options: {
  readonly host: RuntimeHost;
  readonly services: LocalService;
  readonly clock: Clock;
  readonly installed: boolean;
}): Promise<ServiceOutcome> => {
  const { host, services, clock } = options;
  if (!options.installed) {
    const installed = await services.install();
    if (!installed.ok) return installed;
  }
  const started = await services.start();
  if (!started.ok) return started;
  const runtime = (): Runtime => host.current.read();
  for (let waited = 0; waited <= READINESS_WAIT_MS; waited += READINESS_POLL_MS) {
    const readiness = await services.readiness();
    const listed = localEnvironment(runtime().projections.environments.read());
    if (listed && (readiness === "starting" || readiness === "ready")) {
      await runtime().connections.retryNow(listed.environmentId);
      return { ok: true, message: started.message };
    }
    if (!listed && readiness === "ready") {
      await host.restart();
      return { ok: true, message: started.message };
    }
    await sleep(clock, READINESS_POLL_MS);
  }
  return { ok: false, message: "The environment on this machine did not answer within a minute: `agent-harness service status` says why." };
};
