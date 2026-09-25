import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionId, type AccountIdentity } from "@agent-harness/contracts";
import type { AccountRef, Adapter, AdapterDescriptor, PromptMessage, ProviderCommand, RunInput } from "../../adapter/contract.js";
import { systemClock, type Clock } from "../../serve/clock.js";
import { configDirQueue as processQueue, type ConfigDirQueue } from "./config-dir-queue.js";
import { withControlQuery } from "./control-query.js";
import { CLAUDE_PROVIDER, ambientConfigDirectory, claudeCredentials, readClaudeStatus, type CommandRunner, type HostEnvironment } from "./credentials.js";
import { bundledExecutable } from "./executable.js";
import { mirrorUserTitle, readGeneratedTitle, readSubagentTranscript, type ClaudeSessionStore } from "./history.js";
import { catalogueOf, staticCatalogue } from "./models.js";
import { CLAUDE_MODES, claudeEffort, claudeMode } from "./options.js";
import { createPlanUsageReader, readUsageMethod, type UsageOutcome } from "./plan-usage.js";
import { ClaudeProcess, checkImages, type ProcessDeps, type ProcessTimings } from "./process.js";

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

export { CLAUDE_PROVIDER };

/**
 * What Claude can do. `providerQueue` and `steering` rest on the pinned
 * SDK's interrupt that cancels the queue (`interrupt({cancelQueued: true})`,
 * answering `cancelled`; `interrupt_cancel_queued_v1` on the bundled
 * 2.1.281's `init`) and its cancel-by-id control (`cancelAsyncMessage`),
 * both present at run time in 0.3.281 and undeclared (`sdk-surface.test.ts`).
 * Titles (read and write) and subagent transcripts go through the SDK's
 * helpers over the environment's session store (#137), so an adapter made
 * without one declares them, and fork, false (`descriptorFor`); transcript delete
 * removes the CLI's own files for the session. Session listing is not
 * offered: every conversation the harness runs is a harness session already.
 * File attachments wait on the staging Artemis does.
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
  subagentTranscripts: true,
  titleRead: true,
  titleWrite: true,
  transcriptDelete: true,
  planUsage: true,
  liveModels: true,
  commands: true,
  imageInput: true,
  fileInput: false,
  modeChange: true,
  instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
  // Every mode is the SDK permission mode of its name (permissions spec, the Claude mapping), available to every account.
  modes: CLAUDE_MODES.map((mode) => ({ mode, available: true, reason: null })),
};

export const DEFAULT_TIMINGS: ProcessTimings & { readonly statusTimeoutMs: number } = {
  settleGraceMs: 2_000,
  interruptTimeoutMs: 8_000,
  decisionSettleMs: 500,
  controlTimeoutMs: 15_000,
  openTimeoutMs: 60_000,
  statusTimeoutMs: 15_000,
};

export interface ClaudeAdapterOptions {
  /** The environment's clock; preset: the system clock. */
  readonly clock?: Clock;
  /** The environment the Claude processes inherit, before the scrub; preset: this process's, copied once when the adapter is made. */
  readonly hostEnv?: HostEnvironment;
  /** The binary runs, status and sign-in use; preset: the SDK's bundled one, found once. Null leaves the SDK to find it. */
  readonly executablePath?: string | null;
  /**
   * The environment's SDK session store (#137, `provider-transcripts/store.ts`):
   * passed on every run, and read for titles and subagent transcripts. Preset:
   * none, and without it the adapter declares neither titles nor subagent transcripts.
   */
  readonly sessionStore?: ClaudeSessionStore;
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
  readonly stopProcess: (sessionId: string, options?: { readonly kill?: boolean }) => Promise<void>;
  /** The machine's own Claude directory, which `accounts.adopt` registers in place. */
  readonly ambientDirectory: () => string;
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

/**
 * What an adapter declares: `CLAUDE_DESCRIPTOR`, less what only the session
 * store serves when it has none: titles, subagent transcripts, and fork,
 * whose copy of the source's provider session is the store's rows and whose
 * resume onto another account loads from it.
 */
const descriptorFor = (hasStore: boolean): AdapterDescriptor =>
  hasStore ? CLAUDE_DESCRIPTOR : { ...CLAUDE_DESCRIPTOR, fork: false, subagentTranscripts: false, titleRead: false, titleWrite: false };

export const createClaudeAdapter = (options: ClaudeAdapterOptions = {}): ClaudeAdapter => {
  const clock = options.clock ?? systemClock;
  // A copy, taken once: the config-directory queue writes CLAUDE_CONFIG_DIR into process.env while a helper runs,
  // and no process composed meanwhile may inherit another account's directory from it.
  const hostEnv: HostEnvironment = { ...(options.hostEnv ?? process.env) };
  const ambient = ambientConfigDirectory(hostEnv);
  const configDirectory = (account: Pick<AccountRef, "directory">): string => account.directory ?? ambient;
  const timings = { ...DEFAULT_TIMINGS, ...options.timings };
  const diagnostic = options.diagnostic ?? ((message: string, detail?: unknown) => console.error(message, ...(detail === undefined ? [] : [detail])));
  let executable = options.executablePath;
  const executablePath = (): string | null => (executable === undefined ? (executable = bundledExecutable()) : executable);
  /** The processes kept by conversation: at most one per harness session. */
  const processes = new Map<string, ClaudeProcess>();

  const status = (account: AccountRef) =>
    readClaudeStatus({
      executable: executablePath(),
      directory: configDirectory(account),
      hostEnv,
      timeoutMs: timings.statusTimeoutMs,
      ...(options.runCommand !== undefined && { run: options.runCommand }),
    });

  const control = (account: AccountRef, cwd: string) => ({
    clock,
    hostEnv,
    executablePath: executablePath(),
    directory: configDirectory(account),
    cwd,
    timeoutMs: timings.controlTimeoutMs,
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
    configDirectory,
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

  const store = options.sessionStore;
  /** The store, which the descriptor declares these methods by; a call without one is the host's bug. */
  const requireStore = (what: string): ClaudeSessionStore => {
    if (store === undefined) throw new Error(`The Claude adapter has no session store to ${what} with.`);
    return store;
  };

  return {
    descriptor: descriptorFor(store !== undefined),
    credentials: claudeCredentials,
    status,
    // The machine's own directory, resolved once: what `accounts.adopt` registers in place (#134).
    ambientDirectory: () => ambient,
    async models(account) {
      try {
        return catalogueOf(await withControlQuery(control(account, tmpdir()), (query) => query.supportedModels()));
      } catch (error) {
        diagnostic(`Listing the models of the Claude account ${account.id} failed; the static list answers.`, error);
        return staticCatalogue();
      }
    },
    createRun(input, context) {
      // Refused before anything spawns: a mode outside the four, an effort or an image type the SDK does not take, a run with nothing to say.
      claudeMode(input.mode);
      claudeEffort(input.effort);
      checkImages(input.prompt);
      if (input.prompt.length === 0) throw new Error("A Claude run starts with a message.");
      const kept = processes.get(input.sessionId);
      let carried: PromptMessage[] = [];
      if (kept !== undefined && !kept.closed) {
        if (kept.canServe(input)) return kept.attach(input, context);
        if (kept.busy) throw new Error("This conversation's Claude process still has work running; stop it before starting a run it cannot serve.");
        // Kept only for a schedule or a grace: let it go, so a fresh process resumes a transcript nobody is writing,
        // and hand the fresh one the queued messages the old one had not opened a turn with.
        diagnostic(`Claude (session ${input.sessionId}): letting the kept process go for a run it cannot serve.`);
        carried = kept.takeQueuedSends();
        void kept.dispose();
      }
      const started = new ClaudeProcess(input, context, deps(input.account));
      processes.set(input.sessionId, started);
      return started.open(input, carried);
    },
    usage: (account) => usage.read(account),
    async commands(account, workspace, scope): Promise<readonly ProviderCommand[]> {
      try {
        // What a run here would offer: the account's plugins, and a trusted repository's own commands.
        const asked = { ...control(account, workspace.path), pluginDirectory: options.pluginDirectory?.(account) ?? null, trusted: scope?.trusted === true };
        const commands = await withControlQuery(asked, (query) => query.supportedCommands());
        return commands.filter((command) => command.name !== "").map((command) => ({ name: command.name, description: command.description }));
      } catch (error) {
        diagnostic(`Listing the commands of the Claude account ${account.id} failed.`, error);
        return [];
      }
    },
    async stopProcess(sessionId, stopOptions) {
      const kept = processes.get(sessionId);
      processes.delete(sessionId);
      if (kept !== undefined) await kept.stop(stopOptions);
    },
    // The provider's own title, from the store-backed listing; never a title the harness mirrored in (#137).
    readTitle: (sessionId) => readGeneratedTitle(requireStore("read a title"), sessionId),
    async writeTitle(sessionId, title) {
      if (!(await mirrorUserTitle(requireStore("mirror a title"), sessionId, title))) {
        diagnostic(`Claude (session ${sessionId}): no stored conversation to mirror the title into yet.`);
      }
    },
    subagentTranscript: (sessionId, agentId) => readSubagentTranscript(requireStore("read a subagent's transcript"), sessionId, agentId),
    /**
     * The CLI's own transcript of the session: every run names its project
     * directory after the harness session, so under each account's directory
     * it is `projects/<session id>` (the first run's file, and anything a kept
     * process wrote there). A store-backed resume leaves nothing there, the
     * SDK deleting its temporary directory; the store's rows go with every
     * purge anyway. Synchronous and idempotent, as the purge needs.
     */
    deleteTranscript(sessionId, accounts) {
      // A harness session id is a UUID: it names one directory, never a path.
      const id = SessionId.parse(sessionId);
      for (const directory of new Set(accounts.map((account) => configDirectory(account)))) {
        rmSync(join(directory, "projects", id), { recursive: true, force: true });
      }
      return undefined;
    },
  };
};

export { claudeCredentials, parseClaudeStatus } from "./credentials.js";
export { CLAUDE_MODES } from "./options.js";
