import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { DRAIN_CAP_MS } from "@agent-harness/contracts/launcher";
import { DEFAULT_PORT, defaultDataDirectory, refusePrivilegedUser, RootRefusedError, type UserCheck } from "@agent-harness/environment";
import { parseName, parseOptions, parsePort, UsageError } from "../args.js";
import { discoverEnvironment, environmentAddress } from "../discover.js";
import { listed } from "../listed.js";
import { readServiceState } from "../launch/state.js";
import { VERSIONS_DIRECTORY } from "../launch/versions.js";
import { NOT_READY } from "../status.js";
import { prepareServiceDirectories, removeEmptyDirectories, writeDefinition } from "./definition.js";
import { LAUNCHER_ENTRY_FILES, renderLauncherEntry, scriptKind } from "./entry.js";
import { ServiceError } from "./errors.js";
import { nameVersion, placeVersion, unpackedVersionOf, type PlacedVersion } from "./layout.js";
import { createServicePlatform, type InstalledDefinition, type ServicePlatform } from "./platform.js";
import { readServiceRecord, removeServiceRecord, writeServiceRecord, type ServiceRecord } from "./record.js";
import { processRunner, type CommandRunner } from "./runner.js";
import { pathLine, renderShim, SHIM_DIRECTORY, SHIM_FILES } from "./shim.js";
import { currentInstallContext, type InstallContext, type ServiceSpec } from "./spec.js";
import { serviceVerdict, type DiscoveryAnswer } from "./status.js";

/**
 * Seams for tests: the context the service is installed in, the runner the
 * service manager commands go through, and the entry script of the CLI that
 * runs, which names the version install lays out. `main.ts` passes none, and
 * no flag or environment variable reaches them.
 */
export interface ServiceSeams {
  readonly installContext?: InstallContext;
  readonly runner?: CommandRunner;
  /** The real path of the running CLI's entry script. Preset: the process's (`process.argv[1]`, links resolved). */
  readonly cliEntry?: string;
}

export interface ServiceContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch: typeof globalThis.fetch;
  readonly user: UserCheck;
  readonly seams: ServiceSeams;
}

/** The platform's service manager, and the data directory `--data-dir` names or the platform's default. */
const resolveService = (
  context: Pick<ServiceContext, "seams">,
  dataDirOption: string | undefined,
): { platform: ServicePlatform; dataDir: string; installContext: InstallContext } => {
  const installContext = context.seams.installContext ?? currentInstallContext();
  const platform = createServicePlatform(installContext, context.seams.runner ?? processRunner);
  const dataDir = dataDirOption === undefined ? defaultDataDirectory(installContext) : resolve(dataDirOption);
  return { platform, dataDir, installContext };
};

/** The real path of this process's CLI entry script, so a linked bin names the files it points at. */
const runningCliEntry = (): string | undefined => {
  const entry = process.argv[1];
  if (entry === undefined) return undefined;
  try {
    return realpathSync(entry);
  } catch {
    return entry;
  }
};

/** The shim is run by name from a PATH, so it is written executable. */
const writeExecutable = (path: string, content: string): void => writeFileSync(path, content, { mode: 0o755 });

/** Runs each put-back, newest first, past any that fails: the error that started them is the one reported. */
const putBack = (steps: readonly (() => void)[]): void => {
  for (const step of [...steps].reverse()) {
    try {
      step();
    } catch {
      // The first error is the one the user sees.
    }
  }
};

/**
 * What a verb says before it stops a running service whose stop drains: the
 * command waits while the launcher lets running runs finish, up to the
 * drain's cap.
 */
const DRAIN_NOTICE = `Stopping the service, waiting up to ${DRAIN_CAP_MS / 60_000} minutes for any running runs to finish.\n`;

/**
 * `service install`: lays out the launcher in the data directory and writes
 * the definition for this platform, which runs the launcher entry as the
 * current user at logon, then records what it wrote in the data directory's
 * `service.json`.
 *
 * When no launcher runs (a first install, a stopped service, or one from
 * before the launcher running `serve` directly) it makes the version this CLI
 * belongs to a version in the versions directory and names it active and the
 * launcher's, in the service state and the launcher version file. While a
 * launcher runs, it alone writes those, so install leaves them and the
 * running service alone, and rewrites only its own files: the definition,
 * the entry and the shim, which take effect at the service's next start. A
 * service from before the launcher that was running is restarted onto it.
 * A refusal puts back everything install wrote.
 */
const install = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, name: { type: "string" } });
  const port = parsePort(values.port, 1) ?? DEFAULT_PORT;
  const name = parseName(values.name);
  const { platform, dataDir, installContext } = resolveService(context, values["data-dir"]);
  const kind = scriptKind(installContext.platform);
  const spec: ServiceSpec = { dataDir, entry: join(dataDir, LAUNCHER_ENTRY_FILES[kind]) };
  const shimPath = join(dataDir, SHIM_DIRECTORY, SHIM_FILES[kind]);

  const previous = readServiceRecord(dataDir);
  const running = await platform.isRunning();
  const launcherRuns = running && previous?.launcherEntry !== undefined;
  // Found before anything is written, so a CLI that is no release's artefact changes nothing.
  const unpacked = launcherRuns ? undefined : unpackedVersionOf(context.seams.cliEntry ?? runningCliEntry(), installContext.platform);

  const dataDirectories = prepareServiceDirectories(spec);
  const undo: (() => void)[] = [];
  let placed: PlacedVersion | undefined;
  let installed: InstalledDefinition | undefined;
  try {
    if (unpacked !== undefined) {
      placed = placeVersion(dataDir, unpacked, undefined, installContext.platform);
      undo.push(placed.undo);
      undo.push(nameVersion(dataDir, placed.version));
    }
    const entry = writeDefinition(spec.entry, renderLauncherEntry(kind, { dataDir, port, name }));
    undo.push(entry.restore);
    const shim = writeDefinition(shimPath, renderShim(kind, dataDir), writeExecutable);
    undo.push(shim.restore);
    // A running service that install restarts is stopped first; where the stop drains, that waits for its runs.
    if (running && !launcherRuns && platform.drainsOnStop) context.stdout(DRAIN_NOTICE);
    installed = await platform.install(spec, { restartRunning: !launcherRuns });
    const created = [...(previous?.createdDirectories ?? []), ...installed.createdDirectories, ...dataDirectories, ...shim.createdDirectories];
    // The record is part of the install: without it status probes the wrong port, so a failed write takes the definition back out.
    writeServiceRecord(dataDir, {
      platform: platform.kind,
      definitionPath: platform.definitionPath(),
      port,
      launcherEntry: spec.entry,
      createdDirectories: [...new Set(created)],
    });
  } catch (error) {
    // A running launcher was left alone, so its definition stays; otherwise the definition just written is taken back out.
    if (installed && !launcherRuns) await platform.uninstall().catch(() => undefined);
    putBack(undo);
    // The folders the platform made for its definition and the data directory's; those the entry and shim writes made
    // (the shim's `bin`) went with their put-backs above, as `writeDefinition`'s restore removes what it created.
    removeEmptyDirectories([...(installed?.createdDirectories ?? []), ...dataDirectories]);
    throw error;
  }

  const shimFolder = join(dataDir, SHIM_DIRECTORY);
  context.stdout(
    [
      ...(placed?.copiedFrom === undefined ? [] : [`Copied ${placed.version} from ${placed.copiedFrom} into ${join(dataDir, VERSIONS_DIRECTORY)}.`]),
      `Installed ${platform.definitionPath()}: the launcher${placed === undefined ? "" : ` of ${placed.version}`} on port ${port}, data directory ${dataDir}.`,
      launcherRuns
        ? "The service is running its launcher, which alone writes the versions, the service state and the launcher version file while it runs, " +
          "so install rewrote only its own files: the definition, the launcher entry, the shim and the record; they take effect at its next start."
        : running
          ? "The service was running without the launcher, so it was restarted onto the launcher."
          : `It starts at your next logon; \`${PRODUCT_NAME} service start\` starts it now.`,
      `The shim ${shimPath} runs the active version. Install edits no shell profile: to put the shim on your PATH, ${
        kind === "sh" ? "add this line to your shell's profile" : "run this line in PowerShell, then sign out and back in"
      }:`,
      `  ${pathLine(kind, shimFolder)}`,
      "",
    ].join("\n"),
  );
  return 0;
};

/**
 * `service uninstall`: stops the service, removes the definition, the
 * launcher entry, the shim and the record, and removes the folders install
 * created that are now empty. The versions, the service state, the launcher
 * version file and what the environment wrote stay in the data directory.
 */
const uninstall = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" } });
  const { platform, dataDir, installContext } = resolveService(context, values["data-dir"]);
  // A record that cannot be read does not keep the definition installed; only the folders it named stay unknown.
  let record: ServiceRecord | undefined;
  let recordProblem: string | undefined;
  try {
    record = readServiceRecord(dataDir);
  } catch (error) {
    recordProblem = error instanceof Error ? error.message : String(error);
  }
  const installed = await platform.isInstalled();
  if (installed) {
    if (platform.drainsOnStop && (await platform.isRunning())) context.stdout(DRAIN_NOTICE);
    await platform.uninstall();
  }
  const kind = scriptKind(installContext.platform);
  const scripts = [
    { path: record?.launcherEntry ?? join(dataDir, LAUNCHER_ENTRY_FILES[kind]), name: "the launcher entry" },
    { path: join(dataDir, SHIM_DIRECTORY, SHIM_FILES[kind]), name: "the shim" },
  ].filter(({ path }) => existsSync(path));
  for (const { path } of scripts) rmSync(path, { force: true });
  const scriptNames = scripts.map(({ name }) => name);
  removeServiceRecord(dataDir);
  removeEmptyDirectories(record?.createdDirectories ?? []);
  if (recordProblem) context.stderr(`${recordProblem} The folders that install created could not be removed.\n`);
  context.stdout(
    installed
      ? `Removed ${listed([platform.definitionPath(), ...scriptNames])}. The data directory keeps the versions and what the environment wrote.\n`
      : `No service is installed.${scriptNames.length > 0 ? ` Removed ${listed(scriptNames)}, which an install left.` : ""}\n`,
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
 * `service stop`: stops the installed service now; it stays installed, and
 * starts again at the next logon or with `service start`. On Windows it
 * stops the logon task's whole process tree, as uninstall does (#1712):
 * Task Scheduler's End alone ends only the task's console host.
 */
const stop = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  refusePrivilegedUser(context.user);
  parseOptions(args, {});
  const { platform } = resolveService(context, undefined);
  if (!(await platform.isInstalled())) {
    context.stderr(`No service is installed. \`${PRODUCT_NAME} service install\` installs it.\n`);
    return 1;
  }
  if (platform.drainsOnStop && (await platform.isRunning())) context.stdout(DRAIN_NOTICE);
  await platform.stop();
  context.stdout(`Stopped. It starts again at your next logon; \`${PRODUCT_NAME} service start\` starts it now.\n`);
  return 0;
};

/**
 * `service status`: installed and running from the service manager, ready
 * from the discovery URL on the port the service was installed on (from the
 * record; `--port` overrides, `DEFAULT_PORT` when there is no record), and
 * from the service state the active version, the running launcher's version
 * (which the launcher records at each handover), a handover that failed, and
 * a pending update. Exits 0 only when installed, running and ready all hold,
 * else `NOT_READY`.
 */
const serviceStatus = async (args: readonly string[], context: ServiceContext): Promise<number> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, json: { type: "boolean" } });
  const { platform, dataDir } = resolveService(context, values["data-dir"]);
  const record = readServiceRecord(dataDir);
  const port = parsePort(values.port, 1) ?? record?.port ?? DEFAULT_PORT;
  const address = environmentAddress(port);
  const [installed, running, discovery] = await Promise.all([
    platform.isInstalled(),
    platform.isRunning(),
    discoverEnvironment(context.fetch, port),
  ]);
  const answer: DiscoveryAnswer =
    discovery.kind === "environment" ? discovery.document.readiness : discovery.kind === "other" ? "not-an-environment" : "nothing";
  const beforeTheLauncher = installed && record !== undefined && record.launcherEntry === undefined;
  const notes = [
    ...(installed ? await platform.notes() : []),
    ...(beforeTheLauncher
      ? [
          `This service runs \`${PRODUCT_NAME} serve\` without the launcher, as installed before it: ` +
            `\`${PRODUCT_NAME} service install\` from a release with the launcher moves it to the launcher and keeps the data directory.`,
        ]
      : []),
  ];
  const verdict = serviceVerdict({ installed, running, answer }, address);
  const definition = platform.definitionPath();
  const read = readServiceState(dataDir);
  const state = "state" in read ? read.state : undefined;

  if (values.json) {
    const readiness = discovery.kind === "environment" ? discovery.document.readiness : null;
    const report = {
      installed,
      running,
      readiness,
      ready: verdict.ready,
      definition,
      address,
      activeVersion: state?.activeVersion ?? null,
      launcherVersion: state?.launcherVersion ?? null,
      pendingUpdate: state?.pendingUpdate ?? null,
      failedHandover: state?.failedHandover ?? null,
      serviceStateProblem: "problem" in read ? read.problem : null,
      summary: verdict.summary,
      notes,
    };
    context.stdout(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const pending = state?.pendingUpdate;
    const failed = state?.failedHandover;
    const versions =
      state !== undefined
        ? [
            `Active version: ${state.activeVersion}`,
            `Launcher version: ${state.launcherVersion}`,
            ...(failed ? [`Failed handover: to the launcher of ${failed.toVersion} at ${failed.at}, so the launcher of ${state.launcherVersion} runs on`] : []),
            `Pending update: ${pending ? `${pending.fromVersion} to ${pending.toVersion} (update ${pending.updateId})` : "none"}`,
          ]
        : installed && "problem" in read
          ? [`Versions: unknown (${read.problem})`]
          : [];
    context.stdout(
      [
        `Installed: ${installed ? `yes (${definition})` : "no"}`,
        `Running: ${running ? "yes" : "no"}`,
        `Ready: ${verdict.readyLine}`,
        ...versions,
        verdict.summary,
        ...notes,
        "",
      ].join("\n"),
    );
  }
  return verdict.ready ? 0 : NOT_READY;
};

/** Whether a service is installed for this OS user, as `service status`'s first line reads it: the terminal UI's service-down offer asks. */
export const serviceInstalled = (context: Pick<ServiceContext, "seams">): Promise<boolean> => resolveService(context, undefined).platform.isInstalled();

/** The port the installed service's environment answers on: the record's, else `DEFAULT_PORT`; a record that cannot be read is a `ServiceError`. */
export const servicePort = (dataDir: string): number => readServiceRecord(dataDir)?.port ?? DEFAULT_PORT;

const VERBS = new Map<string, (args: readonly string[], context: ServiceContext) => Promise<number>>([
  ["install", install],
  ["uninstall", uninstall],
  ["start", start],
  ["stop", stop],
  ["status", serviceStatus],
]);

/** `service <install|uninstall|status|start|stop>`. A refusal or a service manager failure prints one sentence and exits 1. */
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
