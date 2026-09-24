import { parseArgs } from "node:util";
import { Ceiling, DISCOVERY_PATH, PRODUCT_NAME, SCOPES, ScopeSet } from "@agent-harness/contracts";
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
} from "@agent-harness/environment";
import { parseOptions, parsePort, UsageError } from "./args.js";
import { service, type ServiceSeams } from "./service/verbs.js";
import { status } from "./status.js";
import { PairFailure, mintPairing, renderPairing, type Net, type PairArgs } from "./pair.js";
import { TUI_USAGE, tui, type RunTui } from "./tui.js";

const USAGE = [
  `usage: ${PRODUCT_NAME} --version`,
  `       ${PRODUCT_NAME} serve [--data-dir <path>] [--port <n>] [--name <name>]`,
  `       ${PRODUCT_NAME} status [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} service install [--data-dir <path>] [--port <n>]`,
  `       ${PRODUCT_NAME} service uninstall [--data-dir <path>]`,
  `       ${PRODUCT_NAME} service start`,
  `       ${PRODUCT_NAME} service status [--data-dir <path>] [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} pair [--scopes <a,b>] [--ceiling <mode>] [--data-dir <path>] [--port <n>]`,
  `       ${TUI_USAGE}`,
  "",
].join("\n");

export interface CliContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Resolves when the process is asked to stop: `serve` then drains. */
  readonly stopRequested: () => Promise<unknown>;
  /**
   * Seams into the environment for tests. `main.ts` passes none, and no flag
   * or environment variable reaches them, so nothing a user can type lifts
   * the root refusal.
   */
  /** The fetch `status` and `service status` ask the discovery URL with; a seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Seams into the service verbs for tests, under the same rule as `environment`. */
  readonly service?: ServiceSeams;
  readonly environment?: Pick<EnvironmentOptions, "user" | "launcher" | "runs" | "interfaces">;
  /** The network `pair` uses; preset: the platform's `fetch` and `WebSocket`. */
  readonly net?: Net;
  /** The terminal UI `tui` runs; a seam for tests. Preset: the terminal UI package's `runTui`. */
  readonly tui?: RunTui;
}

/**
 * SIGINT or SIGTERM, whichever comes first; either starts the drain. The
 * listeners go with the first, so a second signal during a drain stops the
 * process at once, as the signal's default does.
 */
const signalled = (): Promise<NodeJS.Signals> =>
  new Promise((resolve) => {
    const on = (signal: NodeJS.Signals) => {
      process.off("SIGINT", on);
      process.off("SIGTERM", on);
      resolve(signal);
    };
    process.on("SIGINT", on);
    process.on("SIGTERM", on);
  });

const processContext: CliContext = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
  stopRequested: signalled,
};

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
    if (!parsed.success) throw new UsageError("--ceiling takes a mode name.");
    ceiling = parsed.data;
  }
  return { dataDir: values["data-dir"] ?? defaultDataDirectory(), port: port === undefined ? undefined : Number(port), scopes, ceiling };
};

/**
 * `pair`: mints a pairing code on the environment running on this machine as
 * this OS user, through the bootstrap grant, and prints it as a link, a QR of
 * the link and the short code. The environment must be running.
 */
const pair = async (args: readonly string[], context: CliContext): Promise<number> => {
  const parsed = parsePair(args);
  const net: Net = context.net ?? { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  try {
    context.stdout(renderPairing(await mintPairing(parsed, net)));
    return 0;
  } catch (error) {
    if (!(error instanceof PairFailure)) throw error;
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
    environment = await startEnvironment({ ...parseServe(args), ...context.environment, user });
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
