import { PRODUCT_NAME } from "@agent-harness/contracts";
import { DEFAULT_PORT, HARNESS_VERSION } from "@agent-harness/environment";
import { parseOptions, parsePort } from "./args.js";
import { environmentAddress, discoverEnvironment } from "./discover.js";

export interface StatusContext {
  readonly stdout: (text: string) => void;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Exit code when the environment is not ready: nothing answers (`status`), or
 * the service is not installed, not running or not ready (`service status`).
 * 3, as LSB init scripts report "not running".
 */
export const NOT_READY = 3;

/**
 * `status`: who answers at the discovery URL on the port (preset
 * `DEFAULT_PORT`), with its identity, version and readiness, or a plain
 * sentence that nothing does. Exits 0 when an environment answers, whatever
 * its readiness, and `NOT_READY` when none does.
 */
export const status = async (args: readonly string[], context: StatusContext): Promise<number> => {
  const values = parseOptions(args, { port: { type: "string" }, json: { type: "boolean" } });
  const port = parsePort(values.port, 1) ?? DEFAULT_PORT;
  const address = environmentAddress(port);
  const discovery = await discoverEnvironment(context.fetch, port);

  if (values.json) {
    const report =
      discovery.kind === "environment"
        ? { address, answering: true, environment: discovery.document }
        : { address, answering: false, ...(discovery.kind === "other" && { detail: discovery.detail }) };
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return discovery.kind === "environment" ? 0 : NOT_READY;
  }
  if (discovery.kind === "none") {
    context.stdout(`No environment answers at ${address}.\n`);
    return NOT_READY;
  }
  if (discovery.kind === "other") {
    context.stdout(`Something answers at ${address}, but not as an ${PRODUCT_NAME} environment: ${discovery.detail}.\n`);
    return NOT_READY;
  }
  const { document } = discovery;
  const mismatch = document.harnessVersion === HARNESS_VERSION ? "" : ` (this CLI is ${HARNESS_VERSION})`;
  context.stdout(
    [
      `Environment: ${document.environmentName} (${document.environmentId})`,
      `Version: ${PRODUCT_NAME} ${document.harnessVersion}, protocol ${document.protocolVersion}${mismatch}`,
      `Readiness: ${document.readiness}`,
      `Address: ${address}`,
      "",
    ].join("\n"),
  );
  return 0;
};
