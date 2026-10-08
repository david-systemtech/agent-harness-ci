import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ENVIRONMENT_STREAM_KIND,
  MANAGED_TOOLS,
  MANAGED_TOOL_COMMANDS,
  ManagedToolRow,
  ToolCommandPlatform,
  compareToolVersions,
  documentedCommand,
  managedTool,
  toolCommandMethodOf,
  type ManagedTool,
  type ManagedToolAction,
  type ManagedToolInstallMethod,
  type ManagedToolName,
  type ManagedToolStatus,
  type ResultOf,
  type ToolCommandEntry,
} from "@agent-harness/contracts";
import { ambientConfigDirectory, type HostEnvironment } from "../adapters/claude/credentials.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import { baseEnvironment } from "../terminals/shell.js";
import { commandLine } from "./command-line.js";
import { drivenUpdate, findOnPath, heldBySystem, methodFromShape, versionIn, type FoundTool } from "./detection.js";
import { LATEST_FILE, createLatestVersions, type ReleaseOrigins } from "./latest.js";
import { readLoginPath } from "./login-path.js";
import { systemPackageOwner, type PackageOwnerLookup } from "./package-owner.js";
import { runCommand } from "./run.js";

/**
 * The Managed tools registry (key-managers spec, "Managed tools"; ADR 0011,
 * ADR 0026): one row per tool of the contracts' table, as the environment's
 * last probe found it. A probe reads the login shell's PATH (the machine and
 * user Path on Windows), resolves each tool's name on it, takes its realpath and
 * passes over the harness's own files, runs its `--version` within five
 * seconds on the environment's clock, and reads its install method from
 * where it is, then from the system package that owns it. Probes run at the
 * environment's start and on a refresh a client asks for (Set up or About
 * opening), at most every fifteen minutes; clients never probe. A probe
 * that changes rows appends `tools.updated` with them, against the rows the
 * log last carried (a tool it never carried is not installed), so the first
 * probe after a restart that finds what was there raises none, and neither
 * does a first start that finds no tool. The sign-in director's managed
 * tool and the forge's `gh` read their rows here.
 *
 * A row's action is Update where the closed command table (#376) updates
 * the tool installed the way it was, else Run in a terminal pane, whose row
 * carries the vendor's documented command (#426) that `tools.run` holds
 * back in a tool terminal until a person presses Enter (#1833); Copy only
 * for `vault`, which the harness never runs a command for; Install for a
 * tool not installed. After a tool run the registry probes
 * again at once (`probeNow`), whatever the cadence, reading the PATH anew.
 *
 * Each installed tool's row carries its latest version (#374), cached in the
 * data directory and fetched on a client's refresh at most once a day per
 * tool, from the source its install method matches, else the vendor's feed
 * (`latest.ts`); `tools.list` never waits for it. A version behind the
 * latest is `update-available`, a badge only, and a latest that changes a
 * row appends `tools.updated` with it as a probe's change does.
 */

/** Who the log says appended `tools.updated`. */
export const MANAGED_TOOLS_ACTOR = formatActor({ kind: "system", id: "managed-tools" });

/** How often a refresh may probe again (ADR 0026, the key-manager cadence). */
export const PROBE_INTERVAL_MS = 15 * 60_000;

/** How long a tool's `--version` may take before its version is unknown (ADR 0026). */
export const VERSION_TIMEOUT_MS = 5_000;

/** How long reading the login shell's PATH, or asking a package manager, may take. */
export const LOOKUP_TIMEOUT_MS = 10_000;

export interface ManagedToolsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  /** The data directory, where the tools' latest versions are cached (`LATEST_FILE`). */
  readonly dataDir: string;
  /** Where the latest versions are read, by kind of source. Preset: the real sources (`RELEASE_ORIGINS`); tests point each at a fake. */
  readonly releaseOrigins?: Partial<ReleaseOrigins>;
  /** Reads the PATH each tool is resolved on. Preset: the login shell's (`readLoginPath`), else, when that fails, `hostEnv`'s. */
  readonly readPath?: () => Promise<string>;
  /** Asks which system package owns a file. Preset: `dpkg -S`, then `rpm -qf`, on Linux (`systemPackageOwner`). */
  readonly packageOwner?: PackageOwnerLookup;
  /** The harness's own files: a tool inside them is passed over. */
  readonly ownResources: readonly string[];
  /** The environment the registry's commands start from: a terminal's clean base is made from it. Preset: this process's. */
  readonly hostEnv?: HostEnvironment;
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
  /** The closed command table a row's Update is read from (#376). Preset: the contracts' (`MANAGED_TOOL_COMMANDS`); tests give one of their own. */
  readonly commands?: readonly ToolCommandEntry[];
}

/** What `tools.list` answers. */
export type ToolsListing = ResultOf<"tools.list">;

export interface ManagedTools {
  /** Begins the start's probe. */
  start(): void;
  /**
   * What the registry runs a tool in, once any probe under way has ended: a
   * terminal's clean base with the PATH the last probe resolved the tools
   * on, so a tool runs as it was found, a shim among them (#375: a verify
   * command, its holder's variables laid over it).
   */
  commandEnvironment(): Promise<Record<string, string>>;
  /**
   * The rows, once any probe under way has ended; with `refresh`, a probe
   * first unless one began in the last fifteen minutes, and then the latest
   * versions due fetched, which the answer does not wait for.
   */
  list(options?: { readonly refresh?: boolean | undefined }): Promise<ToolsListing>;
  /** One tool's row, once any probe under way has ended. */
  row(tool: ManagedToolName): Promise<ManagedToolRow>;
  /**
   * One tool's row as last known, at once, never awaiting a probe: the last
   * probe's, else the one the log last carried, else not installed, as a
   * tool the log never carried is (#381: the orientation block reads it).
   */
  known(tool: ManagedToolName): ManagedToolRow;
  /**
   * Probes now, whatever the cadence, once any probe under way has ended, so
   * the PATH is read anew: after a tool run's command exits (#376).
   */
  probeNow(): Promise<void>;
  /**
   * The programs of `names` found on the PATH the last probe resolved the
   * tools on, the harness's own files passed over, once any probe under way
   * has ended: which install methods are available (#376).
   */
  programsOnPath(names: readonly string[]): Promise<ReadonlySet<string>>;
  /** Stops a probe under way, killing what it runs; no row changes after. */
  close(): void;
}

/** What a probe found of an installed tool: where, the version it reported, and how it was installed. */
interface Detected {
  readonly path: string;
  readonly realpath: string;
  readonly version: string | null;
  readonly method: ManagedToolInstallMethod;
}

/**
 * A row's status (ADR 0026): below its minimum (or not known to meet it)
 * first, then an install method that could not be told, then a version
 * behind the latest known, a badge only.
 */
const statusOf = (tool: ManagedTool, { version, method }: Detected, latest: string | null): ManagedToolStatus => {
  if (tool.minimum !== null && (version === null || compareToolVersions(version, tool.minimum) < 0)) return "below-minimum";
  if (method === "unknown") return "method-unknown";
  if (version !== null && latest !== null && compareToolVersions(version, latest) < 0) return "update-available";
  return "current";
};

/**
 * Whether the command table updates `tool` installed by the method `found`
 * says, on any platform (a method's shape says its platform), and the entry
 * drives it where it was found (`drivenUpdate`); `vault`, which has no
 * entry, never.
 */
const drives = (commands: readonly ToolCommandEntry[], tool: ManagedToolName, found: Detected): boolean => {
  const driven = toolCommandMethodOf(found.method);
  return commands.some((entry) => entry.tool === tool && entry.method === driven && drivenUpdate(entry, found) !== null);
};

const notInstalled = (tool: ManagedTool): ManagedToolRow => ({
  tool: tool.name,
  label: tool.label,
  path: null,
  realpath: null,
  version: null,
  latest: null,
  minimum: tool.minimum,
  method: null,
  status: "not-installed",
  action: "install",
  command: null,
});

export const createManagedTools = (options: ManagedToolsOptions): ManagedTools => {
  const { log, clock } = options;
  const platform = options.platform ?? process.platform;
  const commands = options.commands ?? MANAGED_TOOL_COMMANDS;
  /** The table's platform this environment is; null for one it has no commands for. */
  const tablePlatform = ToolCommandPlatform.safeParse(platform).data ?? null;
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  const stream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  const closing = new AbortController();
  const signal = closing.signal;
  /** A terminal's clean base: what a person's shell, and each tool the registry runs, starts from. */
  const base = (): Record<string, string> => baseEnvironment(platform, hostEnv);
  const readPath =
    options.readPath ?? (() => readLoginPath({ clock, env: base(), timeoutMs: LOOKUP_TIMEOUT_MS, signal, platform }));
  const packageOwner = options.packageOwner ?? systemPackageOwner({ clock, env: base, timeoutMs: LOOKUP_TIMEOUT_MS, signal, platform });
  const latest = createLatestVersions({ clock, file: join(options.dataDir, LATEST_FILE), claudeSettingsFile: join(ambientConfigDirectory(hostEnv), "settings.json"), signal, ...(options.releaseOrigins !== undefined && { origins: options.releaseOrigins }) });

  /** What the last probe that gave rows found of each tool; null for one not installed. */
  let detected: ReadonlyMap<ManagedToolName, Detected | null> | null = null;
  let rows: readonly ManagedToolRow[] | null = null;
  let probedAt: Date | null = null;
  /** The PATH the last probe that gave rows resolved them on. */
  let probedPath = "";
  let lastBegun: number | null = null;
  let running: Promise<void> | null = null;
  /** Whether the latest versions are being fetched, and whether a refresh asked for them again meanwhile. */
  let fetching = false;
  let fetchAgain = false;
  /** The rows the log last carried, by tool: what a probe's rows are compared with. Read from the log at the first probe. */
  let recorded: Map<ManagedToolName, ManagedToolRow> | null = null;

  const readRecorded = (): Map<ManagedToolName, ManagedToolRow> => {
    const found = new Map<ManagedToolName, ManagedToolRow>();
    const events = log.read<{ payload: string }>(
      "SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'tools.updated' ORDER BY sequence",
      stream.kind,
      stream.id,
    );
    for (const event of events) {
      const { tools } = JSON.parse(event.payload) as { readonly tools?: unknown };
      for (const carried of Array.isArray(tools) ? tools : []) {
        // A row carried before rows had a latest version (#374), or a Copy row's command (#426), knows none.
        const parsed = ManagedToolRow.safeParse(typeof carried === "object" && carried !== null ? { latest: null, command: null, ...carried } : carried);
        if (parsed.success) found.set(parsed.data.tool, parsed.data);
      }
    }
    return found;
  };

  /** The PATH to resolve on: the login shell's, else this process's, saying why. */
  const pathNow = async (): Promise<string> => {
    try {
      return await readPath();
    } catch (error) {
      if (!signal.aborted) {
        console.error(`The login shell's PATH could not be read, so the managed tools are looked for on the environment's own: ${error instanceof Error ? error.message : String(error)}`);
      }
      return hostEnv["PATH"] ?? hostEnv["Path"] ?? "";
    }
  };

  const versionOf = async (found: FoundTool, env: Readonly<Record<string, string>>): Promise<string | null> => {
    // Run as it was found, not as its realpath: a shim of mise answers for the name it is called by.
    const answer = await runCommand(found.path, ["--version"], { env, clock, timeoutMs: VERSION_TIMEOUT_MS, signal, platform });
    return answer.outcome === "exited" && answer.code === 0 ? versionIn(answer.stdout, answer.stderr) : null;
  };

  const methodOf = async (tool: ManagedToolName, found: FoundTool): Promise<ManagedToolInstallMethod> => {
    const shaped = methodFromShape(tool, found);
    if (shaped !== null) return shaped;
    let owner;
    try {
      owner = await packageOwner(found.realpath);
    } catch (error) {
      owner = { kind: "unknown", why: error instanceof Error ? error.message : String(error) } as const;
    }
    if (owner.kind === "owned") return owner.manager === "dpkg" ? "apt" : "dnf";
    return owner.kind === "none" ? "manual" : "unknown";
  };

  const probeTool = async (tool: ManagedTool, pathValue: string, env: Readonly<Record<string, string>>): Promise<Detected | null> => {
    const found = findOnPath(tool.name, pathValue, { platform, ownResources: options.ownResources });
    if (found === null) return null;
    const [version, method] = await Promise.all([versionOf(found, env), methodOf(tool.name, found)]);
    return { path: found.path, realpath: found.realpath, version, method };
  };

  /** The vendor's documented command a terminal row of `tool` at `realpath` carries, with the programs on `pathValue` deciding which install the table would run. */
  const copyCommand = (tool: ManagedToolName, realpath: string, pathValue: string): string | null => {
    const available = (program: string) => findOnPath(program, pathValue, { platform, ownResources: options.ownResources }) !== null;
    const command = tablePlatform === null ? null : documentedCommand(tool, !heldBySystem(realpath), tablePlatform, available, commands);
    return command === null ? null : commandLine(command, platform);
  };

  /** A tool's row from what the probe found of it on `pathValue` and the latest version known for how it was installed. */
  const rowOf = (tool: ManagedTool, found: Detected | null, pathValue: string): ManagedToolRow => {
    if (found === null) return notInstalled(tool);
    const known = latest.known(tool.name, found.method);
    const driven = drives(commands, tool.name, found);
    const command = driven ? null : copyCommand(tool.name, found.realpath, pathValue);
    const action: ManagedToolAction = driven ? "update" : command === null ? "copy" : "terminal";
    return { ...notInstalled(tool), ...found, latest: known, status: statusOf(tool, found, known), action, command };
  };

  const rowsOf = (found: ReadonlyMap<ManagedToolName, Detected | null>, pathValue: string): ManagedToolRow[] =>
    MANAGED_TOOLS.map((tool) => rowOf(tool, found.get(tool.name) ?? null, pathValue));

  /**
   * Appends the rows that differ from what the log last carried, a tool it
   * never carried reading as not installed; a failed append leaves them to
   * the next probe.
   */
  const notice = (found: readonly ManagedToolRow[]): void => {
    recorded ??= readRecorded();
    const known = recorded;
    const changed = found.filter((row) => !isDeepStrictEqual(row, known.get(row.tool) ?? notInstalled(managedTool(row.tool))));
    if (changed.length === 0) return;
    try {
      log.append(stream, [{ type: "tools.updated", payload: { tools: changed } }], { actor: MANAGED_TOOLS_ACTOR });
    } catch (error) {
      console.error("Noticing the managed tools' changed rows failed; the next probe notices them again:", error);
      return;
    }
    for (const row of changed) known.set(row.tool, row);
  };

  const probe = (): Promise<void> => {
    if (running !== null) return running;
    const begun = clock.now();
    lastBegun = begun.getTime();
    running = (async () => {
      try {
        const pathValue = await pathNow();
        if (signal.aborted) return;
        const env = { ...base(), PATH: pathValue };
        const found = new Map(await Promise.all(MANAGED_TOOLS.map(async (tool) => [tool.name, await probeTool(tool, pathValue, env)] as const)));
        if (signal.aborted) return;
        detected = found;
        rows = rowsOf(found, pathValue);
        probedAt = begun;
        probedPath = pathValue;
        notice(rows);
      } catch (error) {
        console.error("Probing the managed tools failed; the rows are as the last probe left them:", error);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  /**
   * Fetches the latest versions due of the tools the last probe found
   * installed, or once the fetch under way has ended; the latest versions
   * that changed rows append `tools.updated` with them once every fetch has
   * answered, failed or run out of time.
   */
  const refreshLatest = (): void => {
    if (detected === null || signal.aborted) return;
    if (fetching) {
      fetchAgain = true;
      return;
    }
    fetching = true;
    const installed = [...detected].flatMap(([tool, found]) => (found === null ? [] : [{ tool, method: found.method }]));
    void latest
      .refresh(installed)
      .then((changed) => {
        if (!changed || signal.aborted || detected === null) return;
        rows = rowsOf(detected, probedPath);
        notice(rows);
      })
      .catch((error: unknown) => console.error("Fetching the managed tools' latest versions failed; the rows keep the ones last known:", error))
      .finally(() => {
        fetching = false;
        if (fetchAgain) {
          fetchAgain = false;
          refreshLatest();
        }
      });
  };

  const list = async (asked: { readonly refresh?: boolean | undefined } = {}): Promise<ToolsListing> => {
    // Never probed, or no probe gave rows yet; or a refresh fifteen minutes after the last probe began.
    const due = lastBegun === null || rows === null || (asked.refresh === true && clock.now().getTime() - lastBegun >= PROBE_INTERVAL_MS);
    if (due && !signal.aborted) void probe();
    if (running !== null) await running;
    if (rows === null || probedAt === null) throw new Error("The managed tools have not been probed: the environment is closing, or the probe failed.");
    // A client opening Set up or About: the latest versions due are fetched behind the answer, and heard as tools.updated.
    if (asked.refresh === true) refreshLatest();
    return { tools: [...rows], probedAt: probedAt.toISOString() };
  };

  return {
    start: () => void probe(),
    async commandEnvironment() {
      await list();
      return { ...base(), PATH: probedPath };
    },
    list,
    async row(tool) {
      const found = (await list()).tools.find((row) => row.tool === tool);
      if (found === undefined) throw new Error(`The Managed tools table has no ${tool}.`);
      return found;
    },
    known(tool) {
      const probed = rows?.find((row) => row.tool === tool);
      if (probed !== undefined) return probed;
      recorded ??= readRecorded();
      return recorded.get(tool) ?? notInstalled(managedTool(tool));
    },
    async probeNow() {
      if (running !== null) await running;
      if (!signal.aborted) await probe();
    },
    async programsOnPath(names) {
      await list();
      return new Set(names.filter((name) => findOnPath(name, probedPath, { platform, ownResources: options.ownResources }) !== null));
    },
    close: () => closing.abort(),
  };
};
