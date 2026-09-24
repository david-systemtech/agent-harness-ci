import { resolve } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { DEFAULT_PORT, defaultDataDirectory, refusePrivilegedUser, RootRefusedError, type UserCheck } from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "../args.js";
import { environmentAddress, probeEnvironment } from "../probe.js";
import { NOT_ANSWERING } from "../status.js";
import { ServiceError } from "./errors.js";
import { createServicePlatform, type ServicePlatform } from "./platform.js";
import { processRunner, type CommandRunner } from "./runner.js";
import { currentHost, resolveProgram, SERVICE_LABEL, type ServiceHost } from "./spec.js";
import { serviceVerdict } from "./status.js";

/**
 * Seams for tests: the host the service is installed for, the runner the
 * service manager commands go through, and the program the service runs.
 * `main.ts` passes none, and no flag or environment variable reaches them.
 */
export interface ServiceSeams {
  readonly host?: ServiceHost;
  readonly runner?: CommandRunner;
  readonly program?: readonly string[];
}

export interface ServiceContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: typeof globalThis.fetch;
  readonly user: UserCheck;
  readonly seams: ServiceSeams;
}

const platformFor = (context: ServiceContext): { host: ServiceHost; platform: ServicePlatform } => {
  const host = context.seams.host ?? currentHost();
  return { host, platform: createServicePlatform(host, context.seams.runner ?? processRunner) };
};

/** `service install`: writes the definition for this platform, running `serve` as the current user. */
const install = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" } });
  const port = parsePort(values.port, 1) ?? DEFAULT_PORT;
  const { host, platform } = platformFor(context);
  const dataDir = values["data-dir"] === undefined ? defaultDataDirectory(host) : resolve(values["data-dir"]);
  const program = context.seams.program ?? resolveProgram();

  await platform.install({ label: SERVICE_LABEL, program, dataDir, port });
  context.stdout(
    [
      `Installed ${platform.definitionPath()}: \`${PRODUCT_NAME} serve\` on port ${port}, data directory ${dataDir}.`,
      `It starts at your next logon; \`${PRODUCT_NAME} service start\` starts it now.`,
      "",
    ].join("\n"),
  );
  return 0;
};

/** `service uninstall`: stops the service and removes exactly the definition install wrote; the data directory stays. */
const uninstall = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  parseOptions(args, {});
  const { platform } = platformFor(context);
  if (!(await platform.isInstalled())) {
    context.stdout("No service is installed.\n");
    return 0;
  }
  await platform.uninstall();
  context.stdout(`Removed ${platform.definitionPath()}. The data directory is left as it was.\n`);
  return 0;
};

/** `service start`: starts the installed service now. */
const start = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  parseOptions(args, {});
  const { platform } = platformFor(context);
  if (!(await platform.isInstalled())) {
    context.stderr(`No service is installed. \`${PRODUCT_NAME} service install\` installs it.\n`);
    return 1;
  }
  await platform.start();
  context.stdout(`Started. \`${PRODUCT_NAME} service status\` says when it is ready.\n`);
  return 0;
};

/**
 * `service status`: installed and running from the service manager, ready
 * from the discovery URL on the port (preset `DEFAULT_PORT`). Exits 0 only
 * when all three hold, else 3.
 */
const serviceStatus = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const values = parseOptions(args, { port: { type: "string" }, json: { type: "boolean" } });
  const port = parsePort(values.port, 1) ?? DEFAULT_PORT;
  const { platform } = platformFor(context);
  const address = environmentAddress(port);
  const [installed, running, probe] = await Promise.all([
    platform.isInstalled(),
    platform.isRunning(),
    probeEnvironment(context.fetch, port),
  ]);
  const readiness = probe.kind === "environment" ? probe.document.readiness : undefined;
  const notes = installed ? await platform.notes() : [];
  const verdict = serviceVerdict({ installed, running, readiness }, address);
  const definition = platform.definitionPath();

  if (values.json) {
    const report = { installed, running, readiness: readiness ?? null, ready: verdict.ready, definition, address, summary: verdict.summary, notes };
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const why =
      probe.kind === "none"
        ? `nothing answers at ${address}`
        : probe.kind === "other"
          ? `something other than an environment answers at ${address}`
          : readiness !== "ready"
            ? readiness
            : `the service is not ${installed ? "running" : "installed"}`;
    context.stdout(
      [
        `Installed: ${installed ? `yes (${definition})` : "no"}`,
        `Running: ${running ? "yes" : "no"}`,
        `Ready: ${verdict.ready ? "yes" : `no (${why})`}`,
        verdict.summary,
        ...notes,
        "",
      ].join("\n"),
    );
  }
  return verdict.ready ? 0 : NOT_ANSWERING;
};

const VERBS = new Map<string, (args: readonly string[], context: ServiceContext) => Promise<number>>([
  ["install", install],
  ["uninstall", uninstall],
  ["start", start],
  ["status", serviceStatus],
]);

/** `service <install|uninstall|status|start>`. A refusal or a service manager failure prints one sentence and exits 1. */
export const service = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const [verb, ...rest] = args;
  const run = verb === undefined ? undefined : VERBS.get(verb);
  if (run === undefined) {
    throw new UsageError(verb === undefined ? "service needs a verb." : `Unknown service verb ${verb}.`);
  }
  try {
    return await run(rest, context);
  } catch (error) {
    if (error instanceof RootRefusedError || error instanceof ServiceError) {
      context.stderr(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
};
