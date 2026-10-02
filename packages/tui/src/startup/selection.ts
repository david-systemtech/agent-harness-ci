import {
  PRESET_SETTING_KEYS,
  createRuntime,
  type AccountChip,
  type ConnectionCredential,
  type EnvironmentView,
  type ModelChip,
  type Platform,
  type Runtime,
} from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { SERVICE_DOWN, currentEnvironment, environmentsNamed, isPlaceholder, knownEnvironments, nameOf, phaseWords } from "../view.js";

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
  /** `--session <id>`. */
  readonly session?: string | undefined;
  /** `-c`. */
  readonly continueLatest?: boolean | undefined;
  /** `--cwd <path>`, absolute. */
  readonly cwd?: string | undefined;
  /** The process's working directory. */
  readonly currentDirectory: string;
}

/**
 * The session flags, carried as given: resolving the selection opens,
 * creates and runs nothing, and what they come to (the session `-c` means,
 * whether a directory is the environment's) is the caller's to settle.
 */
export interface SessionSelection {
  /** `--session <id>`: a session to continue. */
  readonly sessionId: string | undefined;
  /** `-c`: the newest session in the directory. */
  readonly continueLatest: boolean;
  /** `--cwd` as given; undefined when none was, and the current directory stands. */
  readonly cwd: string | undefined;
  /** `--cwd`, else the current directory: a new session's directory on this machine, as the screen's header shows it. */
  readonly workspace: string;
}

/** The environment chosen, and what a caller without a screen needs to use it. */
export interface TerminalSelection {
  /** The environment, as `projections.environments` lists it: ready. */
  readonly environment: EnvironmentView;
  /** Its connection's address and client session token (`connections.credential`), for the environment's HTTP routes. */
  readonly credential: ConnectionCredential;
  /** The session and directory flags, as given. */
  readonly session: SessionSelection;
  /** The started runtime the environment was chosen on, for the caller's reads and commands there; `close` closes it. */
  readonly runtime: Runtime;
  /** What a new session on the environment starts on, as the screen's new-session card presets it (`projections.newSession`). */
  newSessionPresets(): Promise<NewSessionPresets>;
  /** Closes the runtime. */
  close(): Promise<void>;
}

/** The account and model chips of `projections.newSession` for a new session on the environment chosen. */
export interface NewSessionPresets {
  readonly account: AccountChip;
  readonly model: ModelChip;
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

/** Whether the local environment's grant file is there: an environment this machine has never reached is not running, rather than none. */
const grantPresent = async (platform: Platform): Promise<boolean> => {
  try {
    return (await platform.grant?.read()) !== undefined;
  } catch {
    return false;
  }
};

/** The environment `wanted` names among those the runtime lists, else the one the screen's header shows; or why there is none to use. */
const choose = async (platform: Platform, runtime: Runtime, wanted: string | undefined): Promise<{ readonly ok: true; readonly environment: EnvironmentView } | SelectionRefusal> => {
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
  // The placeholder alone is listed: this machine's environment never answered, and without a grant file there is none here.
  if (environment === undefined || (isPlaceholder(environment) && !(await grantPresent(platform)))) {
    return refused("none", `No environment is known here: \`${PRODUCT_NAME} service install\` sets up this machine's, and \`/pair\` in \`${PRODUCT_NAME} tui\` adds another.`);
  }
  if (environment.phase === "ready") return { ok: true, environment };
  if (environment.kind === "local" && environment.phase === "service-down") return NOT_RUNNING;
  return refused("unreachable", `${nameOf(environment)} cannot be reached now (${phaseWords(environment)}).`);
};

/**
 * `projections.newSession` with the environment in focus, as `--environment`
 * opens the screen's card, followed until what its account and model chips
 * read has answered or failed: the environment's accounts, its models and
 * the preset settings (`PRESET_SETTING_KEYS`). A screen draws each chip as
 * it arrives; a caller without one takes them once, settled.
 */
const newSessionPresets = (runtime: Runtime, environmentId: string): Promise<NewSessionPresets> => {
  const view = runtime.projections.newSession({ focus: { kind: "environment", environmentId } });
  const read = [
    runtime.projections.accounts(environmentId),
    runtime.projections.models(environmentId),
    runtime.requests.cached(environmentId, "settings.get", { keys: [...PRESET_SETTING_KEYS] }),
  ] as const;
  const answered = () => read.every((answer) => answer.read().fetchedAt !== null || answer.read().error !== null);
  return new Promise((resolve) => {
    const following: (() => void)[] = [];
    const settle = () => {
      if (following.length === 0 || !answered()) return;
      const { account, model } = view.read();
      for (const stop of following.splice(0)) stop();
      resolve({ account, model });
    };
    // Following the card fetches what it reads; following the answers too hears each arrive.
    following.push(view.subscribe(settle), ...read.map((answer) => answer.subscribe(settle)));
    settle();
  });
};

/**
 * Starts a client runtime on `platform` (the saved connections read, the
 * local grant exchanged, each connection's first attempt settled), chooses
 * the environment and hands over what using it needs. A refusal, or a start
 * that fails, closes the runtime; a selection leaves it to the caller's
 * `close`.
 */
export const selectOn = async (platform: Platform, request: SelectionRequest): Promise<SelectionOutcome> => {
  const runtime = createRuntime(platform);
  try {
    await runtime.start();
    const choice = await choose(platform, runtime, request.environment);
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
    const session: SessionSelection = {
      sessionId: request.session,
      continueLatest: request.continueLatest ?? false,
      cwd: request.cwd,
      workspace: request.cwd ?? request.currentDirectory,
    };
    return {
      ok: true,
      selection: {
        environment,
        credential,
        session,
        runtime,
        newSessionPresets: () => newSessionPresets(runtime, environment.environmentId),
        close: () => runtime.close(),
      },
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
};
