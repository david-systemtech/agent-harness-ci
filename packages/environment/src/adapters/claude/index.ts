import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountIdentity } from "@agent-harness/contracts";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { AccountRef, Adapter, AdapterDescriptor, ProviderCommand, RunInput } from "../../adapter/contract.js";
import { systemClock, type Clock } from "../../serve/clock.js";
import { configDirQueue as processQueue, type ConfigDirQueue } from "./config-dir-queue.js";
import { withControlQuery } from "./control-query.js";
import { claudeCredentials, readClaudeStatus, type CommandRunner, type HostEnvironment } from "./credentials.js";
import { bundledExecutable } from "./executable.js";
import { catalogueOf, staticCatalogue } from "./models.js";
import { CLAUDE_MODES, claudeEffort, claudeMode } from "./options.js";
import { createPlanUsageReader, readUsageMethod, type UsageOutcome } from "./plan-usage.js";
import { ClaudeProcess, type ProcessDeps, type ProcessTimings } from "./process.js";

/**
 * The Claude adapter (claude-adapter spec; ADR 0015, ADR 0018): the first
 * adapter behind the contract, over the pinned Agent SDK and its bundled
 * binary. It holds the conversation's process by harness session
 * (`process.ts`), so the next run of a conversation attaches to the process
 * the last one left when it can; reads each account's status with the
 * bundled binary; lists models and commands, and reads plan usage, on
 * unsampled queries under the account's directory. The host registers it by
 * its provider id, `claude`.
 */

export const CLAUDE_PROVIDER = "claude";

/**
 * What Claude can do. `providerQueue` and `steering` rest on the pinned
 * SDK's interrupt receipt (`still_queued`, the `interrupt_receipt_v1`
 * capability the bundled 2.1.281 advertises) and its cancel-by-id control
 * (`cancel_async_message`), both verified present in 0.3.281. Session
 * listing, subagent transcripts, titles and transcript delete are the store's
 * and #137's and #122's; file attachments wait on the staging Artemis does.
 */
export const CLAUDE_DESCRIPTOR: AdapterDescriptor = {
  provider: CLAUDE_PROVIDER,
  displayName: "Claude",
  interactivePrompts: true,
  partialMessages: true,
  providerQueue: true,
  steering: true,
  resume: true,
  fork: true,
  rewind: true,
  sessionListing: false,
  subagents: true,
  subagentTranscripts: false,
  titleRead: false,
  titleWrite: false,
  transcriptDelete: false,
  planUsage: true,
  liveModels: true,
  commands: true,
  imageInput: true,
  fileInput: false,
  instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
  modes: [...CLAUDE_MODES],
};

export const DEFAULT_TIMINGS: ProcessTimings & { readonly controlTimeoutMs: number; readonly statusTimeoutMs: number } = {
  settleGraceMs: 2_000,
  queuedTurnGraceMs: 5_000,
  interruptTimeoutMs: 8_000,
  decisionSettleMs: 500,
  idleMs: 0,
  controlTimeoutMs: 15_000,
  statusTimeoutMs: 15_000,
};

export interface ClaudeAdapterOptions {
  /** The environment's clock; preset: the system clock. */
  readonly clock?: Clock;
  /** The environment the Claude processes inherit, before the scrub; preset: this process's. */
  readonly hostEnv?: HostEnvironment;
  /** The binary runs, status and sign-in use; preset: the SDK's bundled one, found once. Null leaves the SDK to find it. */
  readonly executablePath?: string | null;
  /** The environment's SDK session store (#137), passed on every run. */
  readonly sessionStore?: SessionStore;
  /** The account's skill-set plugin directory (ticket 89); preset: none. */
  readonly pluginDirectory?: (account: AccountRef) => string | null;
  /** The directory the per-repository auto-memory directories live under (ADR 0018); preset: none, the CLI's own. */
  readonly autoMemoryRoot?: string;
  /** Runs the bundled binary's status command; preset: a real spawn. */
  readonly runCommand?: CommandRunner;
  /** The config-directory queue; preset: the process's one. */
  readonly configDirQueue?: ConfigDirQueue;
  readonly timings?: Partial<typeof DEFAULT_TIMINGS>;
  /** Where the adapter says what went wrong without a run to say it on; preset: the console. */
  readonly diagnostic?: (message: string, detail?: unknown) => void;
}

export interface ClaudeAdapter extends Adapter {
  readonly commands: NonNullable<Adapter["commands"]>;
  readonly usage: NonNullable<Adapter["usage"]>;
  readonly close: () => void;
}

/**
 * The auto-memory directory of a run's repository (ADR 0018): one per
 * repository identity, else per workspace path, under `root`, shared by every
 * account. Named for a person reading the directory, and hashed so two
 * repositories never share one.
 */
export const autoMemoryDirectory = (root: string, input: Pick<RunInput, "repositoryIdentity" | "workspace">): string => {
  const key = input.repositoryIdentity ?? input.workspace.path;
  const slug =
    key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(-48)
      .replace(/^-+/, "") || "workspace";
  return join(root, `${slug}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`);
};

export const createClaudeAdapter = (options: ClaudeAdapterOptions = {}): ClaudeAdapter => {
  const clock = options.clock ?? systemClock;
  const hostEnv = options.hostEnv ?? process.env;
  const timings = { ...DEFAULT_TIMINGS, ...options.timings };
  const diagnostic = options.diagnostic ?? ((message: string, detail?: unknown) => console.error(message, ...(detail === undefined ? [] : [detail])));
  let executable = options.executablePath;
  const executablePath = (): string | null => (executable === undefined ? (executable = bundledExecutable()) : executable);
  /** The processes kept by conversation: at most one per harness session. */
  const processes = new Map<string, ClaudeProcess>();

  const status = (account: AccountRef) =>
    readClaudeStatus({
      executable: executablePath(),
      directory: account.directory,
      hostEnv,
      timeoutMs: timings.statusTimeoutMs,
      ...(options.runCommand !== undefined && { run: options.runCommand }),
    });

  const control = (account: AccountRef, cwd: string) => ({
    clock,
    hostEnv,
    executablePath: executablePath(),
    directory: account.directory,
    cwd,
    timeoutMs: timings.controlTimeoutMs,
    pluginDirectory: options.pluginDirectory?.(account) ?? null,
  });

  const usage = createPlanUsageReader({
    clock,
    probe: async (account) => {
      const answered = await withControlQuery(control(account, tmpdir()), async (query) => {
        const [info, outcome] = await Promise.all([query.accountInfo().then((found) => found, () => null), readUsageMethod(query)]);
        return { info, outcome: outcome satisfies UsageOutcome };
      });
      let email = answered.info?.email ?? null;
      let organisation = answered.info?.organization ?? null;
      if (email === null || email === "") {
        // The control channel did not say who this is: the status command does.
        const read = await status(account);
        email = read.email;
        organisation = read.orgName;
      }
      if (email === null || email === "") throw new Error(`The Claude account ${account.id} could not be identified: it reported no email.`);
      const identity: AccountIdentity = { provider: CLAUDE_PROVIDER, email, organisation: organisation === "" ? null : organisation };
      return { identity, outcome: answered.outcome };
    },
  });

  const deps = (account: AccountRef): ProcessDeps => ({
    clock,
    hostEnv,
    executablePath,
    sessionStore: options.sessionStore ?? null,
    pluginDirectory: (input) => options.pluginDirectory?.(input.account) ?? null,
    autoMemoryDirectory: (input) => (options.autoMemoryRoot === undefined ? null : autoMemoryDirectory(options.autoMemoryRoot, input)),
    queue: options.configDirQueue ?? processQueue,
    timings,
    diagnostic,
    onRateLimit: (verdict) => usage.fold(account, verdict),
    onClosed: (closed) => {
      if (processes.get(closed.sessionId) === closed) processes.delete(closed.sessionId);
    },
  });

  return {
    descriptor: CLAUDE_DESCRIPTOR,
    credentials: claudeCredentials,
    status,
    async models(account) {
      try {
        return catalogueOf(await withControlQuery(control(account, tmpdir()), (query) => query.supportedModels()));
      } catch (error) {
        diagnostic(`Listing the models of the Claude account ${account.id} failed; the static list answers.`, error);
        return staticCatalogue();
      }
    },
    createRun(input, context) {
      // Refused before anything spawns: a mode outside the four, an effort the SDK does not take, a run with nothing to say.
      claudeMode(input.mode);
      claudeEffort(input.effort);
      if (input.prompt.length === 0) throw new Error("A Claude run starts with a message.");
      const kept = processes.get(input.sessionId);
      if (kept !== undefined && !kept.closed) {
        if (kept.canServe(input)) return kept.attach(input, context);
        if (kept.busy) throw new Error("This conversation's Claude process still has work running; stop it before starting a run it cannot serve.");
        // Retained and idle: let it go, so a fresh process resumes a transcript nobody is writing.
        void kept.dispose();
      }
      const started = new ClaudeProcess(input, context, deps(input.account));
      processes.set(input.sessionId, started);
      return started.open(input);
    },
    usage: (account) => usage.read(account),
    async commands(account, workspace): Promise<readonly ProviderCommand[]> {
      try {
        const commands = await withControlQuery(control(account, workspace.path), (query) => query.supportedCommands());
        return commands.filter((command) => command.name !== "").map((command) => ({ name: command.name, description: command.description }));
      } catch (error) {
        diagnostic(`Listing the commands of the Claude account ${account.id} failed.`, error);
        return [];
      }
    },
    close() {
      for (const kept of [...processes.values()]) void kept.dispose();
      processes.clear();
    },
  };
};

export { claudeCredentials, parseClaudeStatus } from "./credentials.js";
export { CLAUDE_MODES } from "./options.js";
