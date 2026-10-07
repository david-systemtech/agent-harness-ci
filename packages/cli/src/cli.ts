import { parseArgs } from "node:util";
import {
  Ceiling,
  DISCOVERY_PATH,
  MODES,
  NEW_ENVIRONMENT_CHANNEL_VARIABLE,
  NEW_ENVIRONMENT_NAME_VARIABLE,
  PAIRING_PRESET_IDS,
  PRODUCT_NAME,
  PairingPresetId,
  RELEASE_CHANNELS,
  ReleaseChannel,
  SCOPES,
  ScopeSet,
  pairingPreset,
  presetGrant,
} from "@agent-harness/contracts";
import {
  HARNESS_VERSION,
  defaultDataDirectory,
  processUserCheck,
  refusePrivilegedUser,
  RootRefusedError,
  StartupError,
  startEnvironment,
  systemClock,
  type Clock,
  type EnvironmentHandle,
  type EnvironmentOptions,
  type PreflightSeams,
} from "@agent-harness/environment";
import { parseOptions, parsePort, parseWebOrigin, UsageError } from "./args.js";
import { BANK_USAGE, bank } from "./bank.js";
import { BROWSER_USAGE, browser } from "./browser.js";
import { harnessCommand } from "./harness-command.js";
import { launch, LAUNCH_USAGE } from "./launch/verb.js";
import { processContext, type ProcessContext } from "./process-context.js";
import { service, type ServiceSeams } from "./service/verbs.js";
import { STATE_IMPORT_USAGE, stateImport } from "./state-import.js";
import { status } from "./status.js";
import { GIT_CREDENTIAL_USAGE, gitCredential, readStandardInput } from "./git-credential.js";
import { LocalFailure, type Net } from "./local-session.js";
import { LS_USAGE, ls } from "./ls.js";
import { mintPairing, renderPairing, type PairArgs } from "./pair.js";
import { preflight, PREFLIGHT_USAGE } from "./preflight.js";
import { TUI_USAGE, tui, type RunTui } from "./tui.js";
import { UPDATE_USAGE, update } from "./update.js";

const PAIR_USAGE = `${PRODUCT_NAME} pair [--preset <${PAIRING_PRESET_IDS.join("|")}>] [--scopes <a,b>] [--ceiling <mode>] [--data-dir <path>] [--port <n>]`;
const PAIR_HELP = [
  `usage: ${PAIR_USAGE}`,
  "",
  "own-client: My own client — everything for your own devices, a phone included.",
  "  Every scope, including terminal and admin; ceiling bypassPermissions (run without permission checks; the denylist still applies).",
  "program: A program — read, sessions:write and runs:drive; pick --ceiling (initially acceptEdits).",
  "phone: Phone — restricted.",
  "  read, sessions:write and runs:drive; ceiling acceptEdits (accept file edits; ask before other actions when the provider supports it).",
  "  Bypass permissions is unavailable; no terminal or admin access.",
  "custom: Choose --scopes and --ceiling to raise or lower access for a single pairing.",
  "  Initially read (read sessions) and plan (plan without making changes).",
  "Scopes: read (read sessions), sessions:write (organise sessions), runs:drive (drive runs and answer prompts), terminal (terminals, files and diffs), admin (administer the environment).",
  "A code grants at most its minter's scopes and ceiling. My own client is valid on a phone; browser pairing never downgrades the chosen grant.",
  "",
].join("\n");

const USAGE = [
  `usage: ${PRODUCT_NAME} --version`,
  `       ${PRODUCT_NAME} serve [--data-dir <path>] [--port <n>] [--name <name>] [--web-origin <https-origin>]`,
  `       ${PRODUCT_NAME} ${LAUNCH_USAGE}`,
  `       ${PRODUCT_NAME} ${PREFLIGHT_USAGE}`,
  `       ${PRODUCT_NAME} status [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} service install [--data-dir <path>] [--port <n>] [--name <name>]`,
  `       ${PRODUCT_NAME} service uninstall [--data-dir <path>]`,
  `       ${PRODUCT_NAME} service start`,
  `       ${PRODUCT_NAME} service stop`,
  `       ${PRODUCT_NAME} service status [--data-dir <path>] [--port <n>] [--json]`,
  `       ${PAIR_USAGE}`,
  ...UPDATE_USAGE.map((line) => `       ${line}`),
  ...BROWSER_USAGE.map((line) => `       ${line}`),
  ...BANK_USAGE.map((line) => `       ${line}`),
  `       ${GIT_CREDENTIAL_USAGE}`,
  `       ${TUI_USAGE}`,
  `       ${STATE_IMPORT_USAGE}`,
  `       ${LS_USAGE}`,
  "",
].join("\n");

export interface CliContext extends ProcessContext {
  /**
   * Seams into the environment for tests. `main.ts` passes none, and no flag
   * or environment variable reaches them, so nothing a user can type lifts
   * the root refusal.
   */
  /** The fetch `status` and `service status` ask the discovery URL with; a seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Seams into the service verbs for tests, under the same rule as `environment`. */
  readonly service?: ServiceSeams;
  /** What `preflight` loads and runs; seams for tests, under the same rule as `environment`. */
  readonly preflight?: PreflightSeams;
  readonly environment?: Pick<EnvironmentOptions, "user" | "launcher" | "runs" | "interfaces" | "probeContainment" | "containerDetector" | "browser">;
  /** The network `pair`, the `update` verbs and `browser pair` use; preset: the platform's `fetch` and `WebSocket`. */
  readonly net?: Net;
  /** What `browser pair`'s countdown and the `update` verbs' wait on the environment run on; preset: the system clock. A seam for tests. */
  readonly clock?: Pick<Clock, "now" | "setTimeout">;
  /** The terminal UI `tui` runs; a seam for tests. Preset: the terminal UI package's `runTui`. */
  readonly tui?: RunTui;
  /** What `git-credential` reads git's attributes from, `update credential` the token, and `bank draft --body -` the body; preset: the process's standard input. */
  readonly stdin?: () => Promise<string>;
  /** The variables `git-credential` reads, `serve` its new environment's name and channel from, and the `bank` verbs a Claude Code session's id from; preset: the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long `git-credential` waits on the environment; preset fifteen seconds. A seam for tests. */
  readonly gitCredentialTimeoutMs?: number;
  /** The directory the `bank` verbs work in, whose repository scopes the banks, and the one `ls` lists on this machine's environment; preset: the process's working directory. */
  readonly cwd?: string;
}

/** A variable's value trimmed, or undefined when it is unset or blank, as the compose file passes one left unset. */
const given = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * `serve`'s options. A new environment's name is `--name`, else
 * `AGENT_HARNESS_NAME`, and its channel `AGENT_HARNESS_CHANNEL` (#846): the
 * variables the published compose file passes into the container. Only the
 * start that creates the environment uses either.
 */
const parseServe = (args: readonly string[], env: Readonly<Record<string, string | undefined>>): Pick<EnvironmentOptions, "dataDir" | "port" | "name" | "channel" | "webOrigin"> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, name: { type: "string" }, "web-origin": { type: "string" } });
  const port = parsePort(values.port, 0);
  const webOrigin = parseWebOrigin(values["web-origin"] ?? given(env["AGENT_HARNESS_WEB_ORIGIN"]));
  const name = values.name ?? given(env[NEW_ENVIRONMENT_NAME_VARIABLE]);
  const channelValue = given(env[NEW_ENVIRONMENT_CHANNEL_VARIABLE]);
  let channel: ReleaseChannel | undefined;
  if (channelValue !== undefined) {
    const parsed = ReleaseChannel.safeParse(channelValue);
    if (!parsed.success) throw new UsageError(`${NEW_ENVIRONMENT_CHANNEL_VARIABLE} takes ${RELEASE_CHANNELS.join(" or ")}; got ${channelValue}.`);
    channel = parsed.data;
  }
  return {
    ...(values["data-dir"] !== undefined && { dataDir: values["data-dir"] }),
    ...(port !== undefined && { port }),
    ...(name !== undefined && { name }),
    ...(channel !== undefined && { channel }),
    ...(webOrigin !== undefined && { webOrigin }),
  };
};

/**
 * `pair`'s arguments. `--preset` asks for a pairing preset's grant (ADR 0025;
 * #577), with `--scopes` and `--ceiling` only where the preset lets them
 * change (a program's ceiling; a custom code's both); without it, the
 * scopes and ceiling given, each the environment's default when absent.
 */
const parsePair = (args: readonly string[]): PairArgs => {
  let values: { "data-dir"?: string; port?: string; preset?: string; scopes?: string; ceiling?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { "data-dir": { type: "string" }, port: { type: "string" }, preset: { type: "string" }, scopes: { type: "string" }, ceiling: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { port } = values;
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535)) {
    throw new UsageError(`--port takes a port number from 1 to 65535; got ${port}.`);
  }
  let scopes: ScopeSet | undefined;
  if (values.scopes !== undefined) {
    const parsed = ScopeSet.safeParse(values.scopes === "" ? [] : values.scopes.split(",").map((scope) => scope.trim()));
    if (!parsed.success) throw new UsageError(`--scopes takes a comma-separated set of ${SCOPES.join(", ")}; got ${values.scopes}.`);
    scopes = parsed.data;
  }
  let ceiling: Ceiling | undefined;
  if (values.ceiling !== undefined) {
    const parsed = Ceiling.safeParse(values.ceiling);
    if (!parsed.success) throw new UsageError(`--ceiling takes one of ${MODES.join(", ")}; got ${values.ceiling === "" ? "nothing" : values.ceiling}.`);
    ceiling = parsed.data;
  }
  const target = { dataDir: values["data-dir"] ?? defaultDataDirectory(), port: port === undefined ? undefined : Number(port) };
  if (values.preset === undefined) return { ...target, scopes, ceiling };
  const id = PairingPresetId.safeParse(values.preset);
  if (!id.success) throw new UsageError(`--preset takes one of ${PAIRING_PRESET_IDS.join(", ")}; got ${values.preset === "" ? "nothing" : values.preset}.`);
  const preset = pairingPreset(id.data);
  const grant = presetGrant(preset, { ...(scopes !== undefined && { scopes }), ...(ceiling !== undefined && { ceiling }) });
  if (!grant.ok) throw new UsageError(grant.message);
  return { ...target, scopes: grant.scopes, ceiling: grant.ceiling, preset };
};

/** The network the verbs that reach the local environment use: the context's, else the platform's. */
const netOf = (context: CliContext): Net => context.net ?? { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };

/**
 * `pair`: mints a pairing code on the environment running on this machine as
 * this OS user, through the bootstrap grant, and prints it as a link, a QR of
 * the link and the short code. The environment must be running.
 */
const pair = async (args: readonly string[], context: CliContext): Promise<number> => {
  if (args.length === 1 && args[0] === "--help") {
    context.stdout(PAIR_HELP);
    return 0;
  }
  const parsed = parsePair(args);
  const net = netOf(context);
  try {
    context.stdout(renderPairing(await mintPairing(parsed, net), parsed.preset));
    return 0;
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};

/**
 * `serve`: runs the environment, printing the discovery address once it is
 * ready (and, in a declared container no client has paired with yet, a
 * pairing as `pair` prints it), until a drain ends: one SIGINT or SIGTERM
 * starts, or the launcher's drain query or `environment.drain`. Everything
 * it does is the environment package's; this only refuses, parses, prints
 * and waits. The refusal comes before the arguments are read, so no
 * argument gets past it.
 */
const serve = async (args: readonly string[], context: CliContext): Promise<number> => {
  const user = context.environment?.user ?? processUserCheck();
  let environment: EnvironmentHandle;
  try {
    refusePrivilegedUser(user);
    const options = parseServe(args, context.env ?? process.env);
    // git names this command, with git-credential, as its credential helper (#314): under a launcher, the shim (#459), with
    // what it reads as it runs, which a contained run's sandbox must let it read (#705).
    const underLauncher = context.environment?.launcher?.present() ?? typeof process.send === "function";
    const { command, reads } = harnessCommand(options.dataDir ?? defaultDataDirectory(), underLauncher);
    environment = await startEnvironment({ ...options, harnessCommand: command, harnessReads: reads, ...context.environment, user });
  } catch (error) {
    if (error instanceof RootRefusedError) {
      context.stderr(`${error.message}\n`);
      return 1;
    }
    if (error instanceof StartupError) {
      context.stderr(`${PRODUCT_NAME} could not start: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const { host, port } = environment.address;
  context.stdout(`http://${host}:${port}${DISCOVERY_PATH}\n`);
  // A declared container no client has paired with pairs from this output, its log (ADR 0025, #349).
  if (environment.startPairing !== undefined) {
    context.stdout(
      `No client has paired with this environment yet. Pair one with this code, or run ${PRODUCT_NAME} pair --preset own-client --data-dir ${environment.dataDir} in the container for a new one.\n${renderPairing(environment.startPairing)}`,
    );
  }
  // The drain's own end is awaited below, whatever started it.
  void context.stopRequested().then(() => environment.drain("signal")).catch(() => undefined);
  try {
    await environment.drained;
  } catch (error) {
    context.stderr(`${PRODUCT_NAME} did not stop cleanly: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return 0;
};

/** Runs the CLI on `args` and resolves to its exit code; `overrides` replace the process's streams and signals. */
export const runCli = async (args: readonly string[], overrides: Partial<CliContext> = {}): Promise<number> => {
  const context: CliContext = { ...processContext, ...overrides };
  try {
    if (args.length === 1 && args[0] === "--version") {
      context.stdout(`${PRODUCT_NAME} ${HARNESS_VERSION}\n`);
      return 0;
    }
    if (args[0] === "serve") return await serve(args.slice(1), context);
    if (args[0] === "launch") return await launch(args.slice(1), context);
    if (args[0] === "preflight") return await preflight(args.slice(1), { stdout: context.stdout, stderr: context.stderr, seams: context.preflight ?? {} });
    if (args[0] === "status") return await status(args.slice(1), { stdout: context.stdout, fetch: context.fetch ?? fetch });
    if (args[0] === "service") {
      return await service(args.slice(1), {
        stdout: context.stdout,
        stderr: context.stderr,
        fetch: context.fetch ?? fetch,
        user: context.environment?.user ?? processUserCheck(),
        seams: context.service ?? {},
      });
    }
    if (args[0] === "pair") return await pair(args.slice(1), context);
    if (args[0] === "git-credential") {
      return await gitCredential(args.slice(1), {
        stdin: context.stdin ?? readStandardInput,
        stdout: context.stdout,
        stderr: context.stderr,
        env: context.env ?? process.env,
        ...(context.gitCredentialTimeoutMs !== undefined && { timeoutMs: context.gitCredentialTimeoutMs }),
      });
    }
    if (args[0] === "browser") {
      return await browser(args.slice(1), {
        stdout: context.stdout,
        stderr: context.stderr,
        net: netOf(context),
        clock: context.clock ?? systemClock,
        stopRequested: context.stopRequested,
      });
    }
    if (args[0] === "bank") {
      return await bank(args.slice(1), {
        stdout: context.stdout,
        stderr: context.stderr,
        net: netOf(context),
        cwd: context.cwd ?? process.cwd(),
        env: context.env ?? process.env,
        stdin: context.stdin ?? readStandardInput,
      });
    }
    if (args[0] === "state-import") return await stateImport(args.slice(1), { stdout: context.stdout, stderr: context.stderr, net: netOf(context) });
    if (args[0] === "update") {
      return await update(args.slice(1), { stdout: context.stdout, stderr: context.stderr, stdin: context.stdin ?? readStandardInput, net: netOf(context), clock: context.clock ?? systemClock });
    }
    if (args[0] === "tui") {
      return await tui(args.slice(1), {
        stdout: context.stdout,
        stderr: context.stderr,
        stopRequested: context.stopRequested,
        outputClosed: context.outputClosed,
        fetch: context.fetch ?? fetch,
        user: context.environment?.user ?? processUserCheck(),
        seams: context.service ?? {},
        runTui: context.tui,
      });
    }
    if (args[0] === "ls") return await ls(args.slice(1), { stdout: context.stdout, stderr: context.stderr, seams: context.service ?? {}, cwd: context.cwd ?? process.cwd() });
    throw new UsageError(args.length === 0 ? "No command given." : `Unknown command ${args[0]}.`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\n${USAGE}`);
    return 2;
  }
};
