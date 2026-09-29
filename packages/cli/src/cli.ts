import { parseArgs } from "node:util";
import { Ceiling, DISCOVERY_PATH, MODES, PRODUCT_NAME, SCOPES, ScopeSet } from "@agent-harness/contracts";
import {
  HARNESS_VERSION,
  defaultDataDirectory,
  processUserCheck,
  refusePrivilegedUser,
  RootRefusedError,
  StartupError,
  startEnvironment,
  type EnvironmentHandle,
  type EnvironmentOptions,
  type PreflightSeams,
} from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "./args.js";
import { harnessCommand } from "./harness-command.js";
import { launch, LAUNCH_USAGE } from "./launch/verb.js";
import { processContext, type ProcessContext } from "./process-context.js";
import { service, type ServiceSeams } from "./service/verbs.js";
import { status } from "./status.js";
import { GIT_CREDENTIAL_USAGE, gitCredential, readStandardInput } from "./git-credential.js";
import { LocalFailure, type Net } from "./local-session.js";
import { mintPairing, renderPairing, type PairArgs } from "./pair.js";
import { preflight, PREFLIGHT_USAGE } from "./preflight.js";
import { TUI_USAGE, tui, type RunTui } from "./tui.js";
import { UPDATE_USAGE, update } from "./update.js";

const USAGE = [
  `usage: ${PRODUCT_NAME} --version`,
  `       ${PRODUCT_NAME} serve [--data-dir <path>] [--port <n>] [--name <name>]`,
  `       ${PRODUCT_NAME} ${LAUNCH_USAGE}`,
  `       ${PRODUCT_NAME} ${PREFLIGHT_USAGE}`,
  `       ${PRODUCT_NAME} status [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} service install [--data-dir <path>] [--port <n>] [--name <name>]`,
  `       ${PRODUCT_NAME} service uninstall [--data-dir <path>]`,
  `       ${PRODUCT_NAME} service start`,
  `       ${PRODUCT_NAME} service status [--data-dir <path>] [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} pair [--scopes <a,b>] [--ceiling <mode>] [--data-dir <path>] [--port <n>]`,
  ...UPDATE_USAGE.map((line) => `       ${line}`),
  `       ${GIT_CREDENTIAL_USAGE}`,
  `       ${TUI_USAGE}`,
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
  readonly environment?: Pick<EnvironmentOptions, "user" | "launcher" | "runs" | "interfaces" | "probeContainment">;
  /** The network `pair` and the `update` verbs use; preset: the platform's `fetch` and `WebSocket`. */
  readonly net?: Net;
  /** The terminal UI `tui` runs; a seam for tests. Preset: the terminal UI package's `runTui`. */
  readonly tui?: RunTui;
  /** What `git-credential` reads git's attributes from, and `update credential` the token; preset: the process's standard input. */
  readonly stdin?: () => Promise<string>;
  /** The variables `git-credential` reads; preset: the process's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** How long `git-credential` waits on the environment; preset fifteen seconds. A seam for tests. */
  readonly gitCredentialTimeoutMs?: number;
}

const parseServe = (args: readonly string[]): Pick<EnvironmentOptions, "dataDir" | "port" | "name"> => {
  const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, name: { type: "string" } });
  const port = parsePort(values.port, 0);
  return {
    ...(values["data-dir"] !== undefined && { dataDir: values["data-dir"] }),
    ...(port !== undefined && { port }),
    ...(values.name !== undefined && { name: values.name }),
  };
};

const parsePair = (args: readonly string[]): PairArgs => {
  let values: { "data-dir"?: string; port?: string; scopes?: string; ceiling?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { "data-dir": { type: "string" }, port: { type: "string" }, scopes: { type: "string" }, ceiling: { type: "string" } },
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
  return { dataDir: values["data-dir"] ?? defaultDataDirectory(), port: port === undefined ? undefined : Number(port), scopes, ceiling };
};

/** The network the verbs that reach the local environment use: the context's, else the platform's. */
const netOf = (context: CliContext): Net => context.net ?? { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };

/**
 * `pair`: mints a pairing code on the environment running on this machine as
 * this OS user, through the bootstrap grant, and prints it as a link, a QR of
 * the link and the short code. The environment must be running.
 */
const pair = async (args: readonly string[], context: CliContext): Promise<number> => {
  const parsed = parsePair(args);
  const net = netOf(context);
  try {
    context.stdout(renderPairing(await mintPairing(parsed, net)));
    return 0;
  } catch (error) {
    if (!(error instanceof LocalFailure)) throw error;
    context.stderr(`${error.message}\n`);
    return 1;
  }
};

/**
 * `serve`: runs the environment, printing the discovery address once it is
 * ready, until a drain ends: one SIGINT or SIGTERM starts, or the launcher's
 * drain query or `environment.drain`. Everything it does is the environment
 * package's; this only refuses, parses, prints and waits. The refusal comes
 * before the arguments are read, so no argument gets past it.
 */
const serve = async (args: readonly string[], context: CliContext): Promise<number> => {
  const user = context.environment?.user ?? processUserCheck();
  let environment: EnvironmentHandle;
  try {
    refusePrivilegedUser(user);
    const options = parseServe(args);
    // git names this command, with git-credential, as its credential helper (#314): under a launcher, the shim (#459).
    const underLauncher = context.environment?.launcher?.present() ?? typeof process.send === "function";
    const command = harnessCommand(options.dataDir ?? defaultDataDirectory(), underLauncher);
    environment = await startEnvironment({ ...options, harnessCommand: command, ...context.environment, user });
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
    if (args[0] === "update") return await update(args.slice(1), { stdout: context.stdout, stderr: context.stderr, stdin: context.stdin ?? readStandardInput, net: netOf(context) });
    if (args[0] === "tui") {
      return await tui(args.slice(1), {
        fetch: context.fetch ?? fetch,
        user: context.environment?.user ?? processUserCheck(),
        seams: context.service ?? {},
        runTui: context.tui,
      });
    }
    throw new UsageError(args.length === 0 ? "No command given." : `Unknown command ${args[0]}.`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\n${USAGE}`);
    return 2;
  }
};
