import { DISCOVERY_PATH, PRODUCT_NAME } from "@agent-harness/contracts";
import {
  HARNESS_VERSION,
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

const USAGE = [
  `usage: ${PRODUCT_NAME} --version`,
  `       ${PRODUCT_NAME} serve [--data-dir <path>] [--port <n>] [--name <name>]`,
  `       ${PRODUCT_NAME} status [--port <n>] [--json]`,
  `       ${PRODUCT_NAME} service install [--data-dir <path>] [--port <n>]`,
  `       ${PRODUCT_NAME} service uninstall [--data-dir <path>]`,
  `       ${PRODUCT_NAME} service start`,
  `       ${PRODUCT_NAME} service status [--data-dir <path>] [--port <n>] [--json]`,
  "",
].join("\n");

export interface CliContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Resolves when the process is asked to stop. */
  readonly stopRequested: () => Promise<unknown>;
  /**
   * Seams into the environment for tests. `main.ts` passes none, and no flag
   * or environment variable reaches them, so nothing a user can type lifts
   * the root refusal.
   */
  readonly environment?: Pick<EnvironmentOptions, "user" | "launcher">;
  /** The fetch `status` and `service status` ask the discovery URL with; a seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
  /** Seams into the service verbs for tests, under the same rule as `environment`. */
  readonly service?: ServiceSeams;
}

/** SIGINT or SIGTERM, whichever comes first. The drain SIGTERM starts arrives with #112. */
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

/**
 * `serve`: runs the environment in the foreground until SIGINT or SIGTERM,
 * printing the discovery address once it is ready. Everything it does is the
 * environment package's; this only refuses, parses, prints and waits. The
 * refusal comes before the arguments are read, so no argument gets past it.
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
  await context.stopRequested();
  await environment.close();
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
    throw new UsageError(args.length === 0 ? "No command given." : `Unknown command ${args[0]}.`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\n${USAGE}`);
    return 2;
  }
};
