/**
 * What the worker says about its connection, kept in `chrome.storage.session`
 * under `STATUS_KEY` for the options page to show, and the sentence it is
 * shown as.
 */

export const STATUS_KEY = "status";

export type WorkerStatus =
  /** The worker has started and not yet read its port. */
  | { readonly state: "starting" }
  /** No port to dial: the folder holds no port file, or one that cannot be read, and no override is set. */
  | { readonly state: "no-port"; readonly problem: string }
  | { readonly state: "connecting"; readonly port: number }
  /** Nothing took the socket on the port. */
  | { readonly state: "unreachable"; readonly port: number }
  /** Announced and holding its socket open; `forgotten` is why the pairing it held was forgotten, if it was. */
  | { readonly state: "unpaired"; readonly port: number; readonly environmentName: string; readonly forgotten?: string }
  /** Paired, and its socket proved (or just paired). */
  | { readonly state: "connected"; readonly port: number; readonly environmentName: string; readonly name: string }
  /** Another environment than the one it paired with answered on the port, so it did not prove itself there. */
  | { readonly state: "other-environment"; readonly port: number; readonly pairedWith: string }
  /** The environment refused its opening, and why: another bridge version's Reload sentence, say. */
  | { readonly state: "refused"; readonly port: number; readonly reason: string };

/** The status as the options page says it. */
export const describeStatus = (status: WorkerStatus): string => {
  switch (status.state) {
    case "starting":
      return "Starting.";
    case "no-port":
      return status.problem;
    case "connecting":
      return `Connecting to the environment on port ${status.port}.`;
    case "unreachable":
      return `Nothing answers on port ${status.port}. Start the environment, or set the port it listens on below.`;
    case "unpaired":
      return [
        ...(status.forgotten === undefined ? [] : [`This Chrome's pairing was forgotten: ${status.forgotten}`]),
        `Connected to ${status.environmentName}, and not paired. Type the code ${status.environmentName} shows to pair this Chrome.`,
      ].join(" ");
    case "connected":
      return status.name === "" ? `Paired with ${status.environmentName}, and connected.` : `Paired with ${status.environmentName} as ${status.name}, and connected.`;
    case "other-environment":
      return `Another environment holds port ${status.port}. This Chrome is paired with ${status.pairedWith}, so it does not prove itself to this one. Start ${status.pairedWith}, or set the port it listens on below.`;
    case "refused":
      return `The environment on port ${status.port} refused this extension: ${status.reason}`;
  }
};
