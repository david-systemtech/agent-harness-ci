import { PRODUCT_NAME, type EnvironmentReadiness } from "@agent-harness/contracts";

/** What the discovery URL answered: an environment's readiness, nothing at all, or something that is not an environment. */
export type DiscoveryAnswer = EnvironmentReadiness | "nothing" | "not-an-environment";

/** What `service status` found: the service manager's two answers and the discovery URL's. */
export interface ServiceFacts {
  readonly installed: boolean;
  readonly running: boolean;
  readonly answer: DiscoveryAnswer;
}

export interface ServiceVerdict {
  /** Installed, running, and the environment at the address says `ready`. */
  readonly ready: boolean;
  /** The value of the status's `Ready:` line: `yes`, or `no` with the reason. */
  readonly readyLine: string;
  /** One sentence for the user: what the combination means and, when something is wrong, what to run. */
  readonly summary: string;
}

const install = `\`${PRODUCT_NAME} service install\``;

/**
 * The state table of `service status`: installed and running come from the
 * service manager, ready from the discovery URL at `address`, and only all
 * three together are ready. An environment answering when the service is not
 * running was started another way and is said to be.
 */
export const serviceVerdict = ({ installed, running, answer }: ServiceFacts, address: string): ServiceVerdict => {
  const ready = installed && running && answer === "ready";
  const readyLine = ready
    ? "yes"
    : `no (${
        answer === "nothing"
          ? `nothing answers at ${address}`
          : answer === "not-an-environment"
            ? `something other than an environment answers at ${address}`
            : answer !== "ready"
              ? answer
              : `the service is not ${installed ? "running" : "installed"}`
      })`;
  return { ready, readyLine, summary: summarise(installed, running, answer, address) };
};

const summarise = (installed: boolean, running: boolean, answer: DiscoveryAnswer, address: string): string => {
  const environment = answer !== "nothing" && answer !== "not-an-environment";
  if (!installed) {
    if (running) return `The service is running, but its definition is gone. ${install} puts it back.`;
    if (answer === "nothing") return `No service is installed. ${install} installs it.`;
    if (answer === "not-an-environment") return `No service is installed, and something other than an environment answers at ${address}.`;
    return `No service is installed, but an environment answers at ${address}: it was started another way, such as \`${PRODUCT_NAME} serve\` in a terminal.`;
  }
  if (!running) {
    if (answer === "nothing") return `The service is installed but not running. \`${PRODUCT_NAME} service start\` starts it.`;
    if (!environment) {
      return `The service is installed but not running, and something other than an environment answers at ${address}, on the port the service would use.`;
    }
    return `The service is installed but not running; the environment answering at ${address} was started another way and holds the port the service would use.`;
  }
  switch (answer) {
    case "nothing":
      return `The service is running, but nothing answers at ${address}: it is still starting, or it could not bind that port.`;
    case "not-an-environment":
      return `The service is running, but something other than an environment answers at ${address}: another program holds that port.`;
    case "draining":
      return `The service is running and the environment at ${address} is draining before a restart.`;
    default:
      return `The service is running and the environment at ${address} is ${answer}.`;
  }
};
