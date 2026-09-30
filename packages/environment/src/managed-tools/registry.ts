import { isDeepStrictEqual } from "node:util";
import {
  ENVIRONMENT_STREAM_KIND,
  MANAGED_TOOLS,
  ToolsUpdatedPayload,
  compareToolVersions,
  managedTool,
  type ManagedTool,
  type ManagedToolAction,
  type ManagedToolInstallMethod,
  type ManagedToolName,
  type ManagedToolRow,
  type ManagedToolStatus,
  type ResultOf,
} from "@agent-harness/contracts";
import type { HostEnvironment } from "../adapters/claude/credentials.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import { baseEnvironment } from "../terminals/shell.js";
import { findOnPath, methodFromShape, versionIn, type FoundTool } from "./detection.js";
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
 */

/** Who the log says appended `tools.updated`. */
export const MANAGED_TOOLS_ACTOR = formatActor({ kind: "system", id: "managed-tools" });

/** How often a refresh may probe again (ADR 0026, the key-manager cadence). */
export const PROBE_INTERVAL_MS = 15 * 60_000;

/** How long a tool's `--version` may take before its version is unknown (ADR 0026). */
export const VERSION_TIMEOUT_MS = 5_000;

/** How long reading the login shell's PATH, or asking a package manager, may take. */
export const LOOKUP_TIMEOUT_MS = 10_000;

/** The install methods whose Update the harness can run (#376's command table); every other installed tool's action is Copy the command. */
const DRIVEN_METHODS: ReadonlySet<ManagedToolInstallMethod> = new Set(["homebrew", "winget", "npm", "native", "apt", "dnf"]);

export interface ManagedToolsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
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
  /** The rows, once any probe under way has ended; with `refresh`, a probe first unless one began in the last fifteen minutes. */
  list(options?: { readonly refresh?: boolean | undefined }): Promise<ToolsListing>;
  /** One tool's row, once any probe under way has ended. */
  row(tool: ManagedToolName): Promise<ManagedToolRow>;
  /**
   * One tool's row as last known, at once, never awaiting a probe: the last
   * probe's, else the one the log last carried, else not installed, as a
   * tool the log never carried is (#381: the orientation block reads it).
   */
  known(tool: ManagedToolName): ManagedToolRow;
  /** Stops a probe under way, killing what it runs; no row changes after. */
  close(): void;
}

/** A row's status (ADR 0026): below its minimum (or not known to meet it) first, then an install method that could not be told. */
const statusOf = (tool: ManagedTool, version: string | null, method: ManagedToolInstallMethod): ManagedToolStatus => {
  if (tool.minimum !== null && (version === null || compareToolVersions(version, tool.minimum) < 0)) return "below-minimum";
  if (method === "unknown") return "method-unknown";
  return "current";
};

const actionOf = (method: ManagedToolInstallMethod): ManagedToolAction => (DRIVEN_METHODS.has(method) ? "update" : "copy");

const notInstalled = (tool: ManagedTool): ManagedToolRow => ({
  tool: tool.name,
  label: tool.label,
  path: null,
  realpath: null,
  version: null,
  minimum: tool.minimum,
  method: null,
  status: "not-installed",
  action: "install",
});

export const createManagedTools = (options: ManagedToolsOptions): ManagedTools => {
  const { log, clock } = options;
  const platform = options.platform ?? process.platform;
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  const stream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  const closing = new AbortController();
  const signal = closing.signal;
  /** A terminal's clean base: what a person's shell, and each tool the registry runs, starts from. */
  const base = (): Record<string, string> => baseEnvironment(platform, hostEnv);
  const readPath =
    options.readPath ?? (() => readLoginPath({ clock, env: base(), timeoutMs: LOOKUP_TIMEOUT_MS, signal, platform }));
  const packageOwner = options.packageOwner ?? systemPackageOwner({ clock, env: base, timeoutMs: LOOKUP_TIMEOUT_MS, signal, platform });

  let rows: readonly ManagedToolRow[] | null = null;
  let probedAt: Date | null = null;
  /** The PATH the last probe that gave rows resolved them on. */
  let probedPath = "";
  let lastBegun: number | null = null;
  let running: Promise<void> | null = null;
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
      const parsed = ToolsUpdatedPayload.safeParse(JSON.parse(event.payload));
      if (parsed.success) for (const row of parsed.data.tools) found.set(row.tool, row);
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

  const probeTool = async (tool: ManagedTool, pathValue: string, env: Readonly<Record<string, string>>): Promise<ManagedToolRow> => {
    const found = findOnPath(tool.name, pathValue, { platform, ownResources: options.ownResources });
    if (found === null) return notInstalled(tool);
    const [version, method] = await Promise.all([versionOf(found, env), methodOf(tool.name, found)]);
    return { ...notInstalled(tool), path: found.path, realpath: found.realpath, version, method, status: statusOf(tool, version, method), action: actionOf(method) };
  };

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
        const found = await Promise.all(MANAGED_TOOLS.map((tool) => probeTool(tool, pathValue, env)));
        if (signal.aborted) return;
        rows = found;
        probedAt = begun;
        probedPath = pathValue;
        notice(found);
      } catch (error) {
        console.error("Probing the managed tools failed; the rows are as the last probe left them:", error);
      }
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const list = async (asked: { readonly refresh?: boolean | undefined } = {}): Promise<ToolsListing> => {
    // Never probed, or no probe gave rows yet; or a refresh fifteen minutes after the last probe began.
    const due = lastBegun === null || rows === null || (asked.refresh === true && clock.now().getTime() - lastBegun >= PROBE_INTERVAL_MS);
    if (due && !signal.aborted) void probe();
    if (running !== null) await running;
    if (rows === null || probedAt === null) throw new Error("The managed tools have not been probed: the environment is closing, or the probe failed.");
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
    close: () => closing.abort(),
  };
};
