import { PRODUCT_NAME, type EnvironmentReadiness } from "@agent-harness/contracts";

/** What `service status` found: the service manager's two answers and the discovery URL's readiness, undefined when nothing answered. */
export interface ServiceFacts {
  readonly installed: boolean;
  readonly running: boolean;
  readonly readiness: EnvironmentReadiness | undefined;
}

export interface ServiceVerdict {
  /** Installed, running, and the environment at the address says `ready`. */
  readonly ready: boolean;
  /** One sentence for the user: what the combination means and, when something is wrong, what to run. */
  readonly summary: string;
}

/**
 * The state table of `service status`: installed and running come from the
 * service manager, ready from the discovery URL at `address`, and only all
 * three together are ready. An environment answering when the service is not
 * running was started another way and is said to be.
 */
export const serviceVerdict = ({ installed, running, readiness }: ServiceFacts, address: string): ServiceVerdict => {
  const ready = installed && running && readiness === "ready";
  if (!installed) {
    if (running) return { ready, summary: `The service is running, but its definition is gone. \`${PRODUCT_NAME} service install\` puts it back.` };
    if (readiness === undefined) return { ready, summary: `No service is installed. \`${PRODUCT_NAME} service install\` installs it.` };
    return {
      ready,
      summary: `No service is installed, but an environment answers at ${address}: it was started another way, such as \`${PRODUCT_NAME} serve\` in a terminal.`,
    };
  }
  if (!running) {
    if (readiness === undefined) {
      return { ready, summary: `The service is installed but not running. \`${PRODUCT_NAME} service start\` starts it.` };
    }
    return {
      ready,
      summary: `The service is installed but not running; the environment answering at ${address} was started another way and holds the port the service would use.`,
    };
  }
  switch (readiness) {
    case undefined:
      return { ready, summary: `The service is running, but nothing answers at ${address}: it is still starting, or it could not bind that port.` };
    case "draining":
      return { ready, summary: `The service is running and the environment at ${address} is draining before a restart.` };
    default:
      return { ready, summary: `The service is running and the environment at ${address} is ${readiness}.` };
  }
};
