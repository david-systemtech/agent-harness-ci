import { parseArgs } from "node:util";
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

const USAGE = [
  `usage: ${PRODUCT_NAME} --version`,
  `       ${PRODUCT_NAME} serve [--data-dir <path>] [--port <n>] [--name <name>]`,
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

class UsageError extends Error {}

const parseServe = (args: readonly string[]): Pick<EnvironmentOptions, "dataDir" | "port" | "name"> => {
  let values: { "data-dir"?: string; port?: string; name?: string };
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: { "data-dir": { type: "string" }, port: { type: "string" }, name: { type: "string" } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { port } = values;
  if (port !== undefined && !(/^\d+$/.test(port) && Number(port) <= 65535)) {
    throw new UsageError(`--port takes a port number from 0 to 65535; got ${port}.`);
  }
  return {
    ...(values["data-dir"] !== undefined && { dataDir: values["data-dir"] }),
    ...(port !== undefined && { port: Number(port) }),
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
    throw new UsageError(args.length === 0 ? "No command given." : `Unknown command ${args[0]}.`);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\n${USAGE}`);
    return 2;
  }
};
