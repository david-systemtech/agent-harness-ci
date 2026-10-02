import type { ConnectionCredential, EnvironmentView, Runtime } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { SERVICE_DOWN, currentEnvironment, environmentsNamed, knownEnvironments, localIsDown, nameOf, phaseWords } from "../view.js";

/**
 * The terminal UI's Environment selection without a screen (#1178), for
 * the CLI's printing and listing (docs/specs/switch-over.md, "Phase-D
 * commands and parity"): the client runtime started on the terminal's own
 * saved connections, secret storage and local grant, the environment
 * chosen by the rules the screen's header follows (`currentEnvironment`,
 * `environmentsNamed`), and what a caller needs to use it handed over. It
 * draws nothing and needs no terminal. A choice it cannot make or use is
 * refused in one line, with the runtime closed.
 */

/** What `agent-harness tui`'s selectors name, as the CLI parsed them, and the directory the command runs in. */
export interface SelectionRequest {
  /** `--environment <name or id>`. */
  readonly environment?: string | undefined;
  /** The process's working directory. */
  readonly currentDirectory: string;
}

/** The environment chosen, and what a caller without a screen needs to use it. */
export interface TerminalSelection {
  /** The environment, as `projections.environments` lists it: ready. */
  readonly environment: EnvironmentView;
  /** Its connection's address and client session token (`connections.credential`), for the environment's HTTP routes. */
  readonly credential: ConnectionCredential;
  /** The started runtime the environment was chosen on, for the caller's reads and commands there; `close` closes it. */
  readonly runtime: Runtime;
  /** Closes the runtime. */
  close(): Promise<void>;
}

/**
 * Why no environment was chosen: nothing is known here (`none`), the name
 * given answers to none (`unknown`) or to more than one (`ambiguous`), or
 * the one chosen cannot be used now (`unreachable`).
 */
export type SelectionRefusalReason = "none" | "unknown" | "ambiguous" | "unreachable";

export interface SelectionRefusal {
  readonly ok: false;
  readonly reason: SelectionRefusalReason;
  /** One line for people. */
  readonly message: string;
}

export type SelectionOutcome = { readonly ok: true; readonly selection: TerminalSelection } | SelectionRefusal;

const refused = (reason: SelectionRefusalReason, message: string): SelectionRefusal => ({ ok: false, reason, message });

/** The service-down offer's sentence, with the verb that answers it, since nobody is there to answer `y`. */
const NOT_RUNNING = refused("unreachable", `${SERVICE_DOWN} \`${PRODUCT_NAME} service start\` starts it.`);

/** The environment `wanted` names among those the runtime lists, else the one the screen's header shows; or why there is none to use. */
const choose = (runtime: Runtime, wanted: string | undefined): { readonly ok: true; readonly environment: EnvironmentView } | SelectionRefusal => {
  const views = runtime.projections.environments.read();
  let environment: EnvironmentView | undefined;
  if (wanted !== undefined) {
    const named = environmentsNamed(knownEnvironments(views), wanted);
    if (named.length === 0) return refused("unknown", `No environment named ${wanted} is known here.`);
    if (named.length > 1) {
      const each = named.map((view) => `${view.environmentId} ${nameOf(view)}`).join(", ");
      return refused("ambiguous", `More than one environment here is named ${wanted}: give the id of the one meant (${each}).`);
    }
    environment = named[0];
  } else {
    environment = currentEnvironment(views, runtime.preferences.read(), undefined);
  }
  if (environment === undefined) {
    if (localIsDown(views, runtime.local.read())) return NOT_RUNNING;
    return refused("none", `No environment is known here: \`${PRODUCT_NAME} service install\` sets up this machine's, and \`/pair\` in \`${PRODUCT_NAME} tui\` adds another.`);
  }
  if (environment.phase === "ready") return { ok: true, environment };
  if (environment.kind === "local" && environment.phase === "service-down") return NOT_RUNNING;
  return refused("unreachable", `${nameOf(environment)} cannot be reached now (${phaseWords(environment)}).`);
};

/**
 * Starts `runtime` (the saved connections read, the local grant exchanged,
 * each connection's first attempt settled), chooses the environment and
 * hands over what using it needs. A refusal, or a start that fails, closes
 * the runtime; a selection leaves it to the caller's `close`.
 */
export const selectOn = async (runtime: Runtime, request: SelectionRequest): Promise<SelectionOutcome> => {
  try {
    await runtime.start();
    const choice = choose(runtime, request.environment);
    if (!choice.ok) {
      await runtime.close();
      return choice;
    }
    const { environment } = choice;
    const credential = await runtime.connections.credential(environment.environmentId);
    if (credential === undefined) {
      await runtime.close();
      return refused("unreachable", `This terminal holds no credential for ${nameOf(environment)} now.`);
    }
    return { ok: true, selection: { environment, credential, runtime, close: () => runtime.close() } };
  } catch (error) {
    await runtime.close();
    throw error;
  }
};
