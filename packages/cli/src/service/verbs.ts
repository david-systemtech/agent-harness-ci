import { resolve } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { DEFAULT_PORT, defaultDataDirectory, refusePrivilegedUser, RootRefusedError, type UserCheck } from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "../args.js";
import { discoverEnvironment, environmentAddress } from "../discover.js";
import { NOT_READY } from "../status.js";
import { prepareServiceDirectories, removeEmptyDirectories } from "./definition.js";
import { ServiceError } from "./errors.js";
import { createServicePlatform, type ServicePlatform } from "./platform.js";
import { readServiceRecord, removeServiceRecord, writeServiceRecord } from "./record.js";
import { processRunner, type CommandRunner } from "./runner.js";
import { currentInstallContext, resolveProgram, type InstallContext } from "./spec.js";
import { serviceVerdict, type DiscoveryAnswer } from "./status.js";

/**
 * Seams for tests: the context the service is installed in, the runner the
 * service manager commands go through, and the program the service runs.
 * `main.ts` passes none, and no flag or environment variable reaches them.
 */
export interface ServiceSeams {
  readonly installContext?: InstallContext;
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

/** The platform's service manager, and the data directory `--data-dir` names or the platform's default. */
const resolveService = (context: ServiceContext, dataDirOption: string | undefined): { platform: ServicePlatform; dataDir: string } => {
  const installContext = context.seams.installContext ?? currentInstallContext();
  const platform = createServicePlatform(installContext, context.seams.runner ?? processRunner);
  const dataDir = dataDirOption === undefined ? defaultDataDirectory(installContext) : resolve(dataDirOption);
  return { platform, dataDir };
};

/**
 * `service install`: prepares the data directory, writes the definition for
 * this platform, running `serve` as the current user, and records what it
 * wrote in the data directory's `service.json`.
 */
const install = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" } });
  const port = parsePort(values.port, 1) ?? DEFAULT_PORT;
  const { platform, dataDir } = resolveService(context, values["data-dir"]);
  const program = context.seams.program ?? resolveProgram();
  const spec = { program, dataDir, port };

  const previous = readServiceRecord(dataDir);
  const dataDirectories = prepareServiceDirectories(spec);
  let installed;
  try {
    installed = await platform.install(spec);
    const created = [...(previous?.createdDirectories ?? []), ...installed.createdDirectories, ...dataDirectories];
    // The record is part of the install: without it status probes the wrong port, so a failed write takes the definition back out.
    writeServiceRecord(dataDir, {
      platform: platform.kind,
      definitionPath: platform.definitionPath(),
      port,
      createdDirectories: [...new Set(created)],
    });
  } catch (error) {
    if (installed) await platform.uninstall().catch(() => undefined);
    // Both the folders the platform made for its definition and the data-directory ones, as the success path records.
    removeEmptyDirectories([...(installed?.createdDirectories ?? []), ...dataDirectories]);
    throw error;
  }
  context.stdout(
    [
      `Installed ${platform.definitionPath()}: \`${PRODUCT_NAME} serve\` on port ${port}, data directory ${dataDir}.`,
      `It starts at your next logon; \`${PRODUCT_NAME} service start\` starts it now.`,
      "",
    ].join("\n"),
  );
  return 0;
};

/**
 * `service uninstall`: stops the service, removes the definition and the
 * record, and removes the folders install created that are now empty; the
 * data directory's contents stay.
 */
const uninstall = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" } });
  const { platform, dataDir } = resolveService(context, values["data-dir"]);
  // A record that cannot be read does not keep the definition installed; only the folders it named stay unknown.
  let record: ReturnType<typeof readServiceRecord>;
  let recordProblem: string | undefined;
  try {
    record = readServiceRecord(dataDir);
  } catch (error) {
    recordProblem = error instanceof Error ? error.message : String(error);
  }
  const installed = await platform.isInstalled();
  if (installed) await platform.uninstall();
  removeServiceRecord(dataDir);
  removeEmptyDirectories(record?.createdDirectories ?? []);
  if (recordProblem) context.stderr(`${recordProblem} The folders that install created could not be removed.\n`);
  context.stdout(
    installed ? `Removed ${platform.definitionPath()}. The data directory keeps what the environment wrote.\n` : "No service is installed.\n",
  );
  return 0;
};

/** `service start`: starts the installed service now. */
const start = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  parseOptions(args, {});
  const { platform } = resolveService(context, undefined);
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
 * from the discovery URL on the port the service was installed on (from the
 * record; `--port` overrides, `DEFAULT_PORT` when there is no record). Exits
 * 0 only when all three hold, else `NOT_READY`.
 */
const serviceStatus = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, json: { type: "boolean" } });
  const { platform, dataDir } = resolveService(context, values["data-dir"]);
  const port = parsePort(values.port, 1) ?? readServiceRecord(dataDir)?.port ?? DEFAULT_PORT;
  const address = environmentAddress(port);
  const [installed, running, discovery] = await Promise.all([
    platform.isInstalled(),
    platform.isRunning(),
    discoverEnvironment(context.fetch, port),
  ]);
  const answer: DiscoveryAnswer =
    discovery.kind === "environment" ? discovery.document.readiness : discovery.kind === "other" ? "not-an-environment" : "nothing";
  const notes = installed ? await platform.notes() : [];
  const verdict = serviceVerdict({ installed, running, answer }, address);
  const definition = platform.definitionPath();

  if (values.json) {
    const readiness = discovery.kind === "environment" ? discovery.document.readiness : null;
    const report = { installed, running, readiness, ready: verdict.ready, definition, address, summary: verdict.summary, notes };
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    context.stdout(
      [
        `Installed: ${installed ? `yes (${definition})` : "no"}`,
        `Running: ${running ? "yes" : "no"}`,
        `Ready: ${verdict.readyLine}`,
        verdict.summary,
        ...notes,
        "",
      ].join("\n"),
    );
  }
  return verdict.ready ? 0 : NOT_READY;
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
