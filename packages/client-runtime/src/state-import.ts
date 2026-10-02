import type { StateImportClientLocal, StateImportReport } from "@agent-harness/contracts";
import type { Runtime } from "./runtime.js";

/**
 * Values the initiating Client may apply through its presentation owner
 * (ADR 0036). The platform's exchanged grant proves the Environment's
 * identity; an address or a paired connection proves nothing about locality.
 * Check the live connection too: a remembered exchange after revocation or
 * disconnection cannot authorise applying values from a late reply.
 */
export const clientLocalImportValues = (
  runtime: Pick<Runtime, "local" | "connections">,
  environmentId: string,
  dryRun: boolean,
  report: StateImportReport | undefined,
): StateImportClientLocal | null => {
  if (dryRun || report === undefined || report.dryRun) return null;
  const local = runtime.local.read();
  if (local.state !== "exchanged" || local.environmentId !== environmentId) return null;
  const connection = runtime.connections.list.read().find((connection) => connection.environmentId === environmentId);
  return connection?.kind === "local" && connection.phase === "ready" ? report.clientLocal : null;
};
