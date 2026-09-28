import { readFileSync } from "node:fs";
import { homedir, hostname, userInfo } from "node:os";
import { join, resolve as absolutePath } from "node:path";
import {
  BOOTSTRAP_PATH,
  ContractError,
  DATABASE_FILE,
  DISCOVERY_PATH,
  ENVIRONMENT_STREAM_KIND,
  GIT_CREDENTIAL_PATH,
  HEALTH_PATH,
  OPENAI_PATH_PREFIX,
  PAIR_PATH,
  PROTOCOL_VERSION,
  SESSION_STREAM_KIND,
  WIRE_PATH,
  formatHostPort,
  pairingLink,
  parkedPromptTtlMs,
  type AuthPolicy,
  type CapabilityFlags,
  type ContainmentReport,
  type DiscoveryDocument,
  type DrainTrigger,
  type EnvironmentReadiness,
  type EnvironmentStatus,
  type HealthDocument,
  type Mode,
  type RunOrigin,
} from "@agent-harness/contracts";
import { SYSTEM, createAccessLog } from "../auth/access-log.js";
import { accessMethods } from "../auth/access-methods.js";
import { createBootstrapGrant } from "../auth/bootstrap.js";
import {
  SWEEP_INTERVAL_MS,
  createClientSessions,
  socketSessions,
  type ClientSessionIssuer,
  type ClientSessions,
} from "../auth/client-sessions.js";
import { createPairings, pairRoute, type Pairings } from "../auth/pairings.js";
import { createRateLimiter } from "../auth/rate-limit.js";
import { formatActor, openEventLog, type EventLog, type Projector } from "../event-log/event-log.js";
import type { Adapter } from "../adapter/contract.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { createPassthrough } from "../completions/passthrough.js";
import { createCompletionsSurface } from "../completions/surface.js";
import { createAdapterHost } from "../adapter/host.js";
import { ACCOUNTS_DIRECTORY, createAccountService, type AccountService, type ConfiguredAccount } from "../accounts/account-service.js";
import { accountsProjector } from "../accounts/account-store.js";
import { accountMethods } from "../accounts/methods.js";
import type { SignInDirectorFactory } from "../accounts/signin-seam.js";
import { createSignInDirector } from "../accounts/signin-director.js";
import type { SignInSpawn } from "../accounts/signin-process.js";
import { CLAUDE_PROVIDER, type HostEnvironment } from "../adapters/claude/credentials.js";
import { bundledExecutable } from "../adapters/claude/executable.js";
import { claudeSignInProgram } from "../adapters/claude/signin.js";
import { readClaudeCodeVersion } from "../adapters/claude/version.js";
import { usageMethods } from "../accounts/usage-methods.js";
import { createUsagePool } from "../accounts/usage-pool.js";
import { processMethods } from "../adapter/processes-methods.js";
import { ATTACHMENTS_DIRECTORY, createAttachmentStage } from "../adapter/attachment-stage.js";
import { recoverCutRuns, recoverStagedAttachments } from "../adapter/recovery.js";
import { noToolServers, type InstructionComposer, type PolicySeam, type PromptAutoAnswer, type ToolGateRule, type ToolServerFactory } from "../adapter/seams.js";
import { autoAnswer } from "../permissions/auto-answer.js";
import { UNPROBED_REPORT, containmentFlags, containmentReport, failedProbeReport, presetContainmentDefault, withAdapters } from "../permissions/containment.js";
import { CONTAINMENT_DIRECTORY, containmentDirectories } from "../permissions/containment-directories.js";
import { probeContainment, type ContainmentProbe } from "../permissions/containment-probe.js";
import { denylistRule, providerDenylist, type DenylistContext } from "../permissions/denylist-gate.js";
import { denylistMethods } from "../permissions/denylist-methods.js";
import { readDenylist, seedDenylist } from "../permissions/denylist-store.js";
import { permissionMethods, sessionModeClamp } from "../permissions/methods.js";
import { promptMethods } from "../permissions/prompt-methods.js";
import { startPromptNotices } from "../permissions/prompt-notices.js";
import { permissionsProjector, readPermissionSettings, readStoredContainmentDefault } from "../permissions/permissions-store.js";
import { policySettings, resolvePolicy, type RunActor } from "../permissions/resolver.js";
import { reviewMethods } from "../permissions/review-methods.js";
import { createTtlSweeper } from "../permissions/ttl-sweeper.js";
import { createProviderTranscriptStore, type ProviderTranscriptStore } from "../provider-transcripts/store.js";
import { runMethods, startRunIn } from "../runs/run-methods.js";
import { createUpdateCoordinator } from "../updates/coordinator.js";
import { updateMethods } from "../updates/methods.js";
import { runsProjector } from "../runs/runs-projector.js";
import { scrubDiagnosticOutput } from "../scrub/diagnostic-output.js";
import { createScrubRegistry, type ScrubRegistry } from "../scrub/registry.js";
import { createCompactionSweep } from "../sessions/compaction.js";
import { createDeletion } from "../sessions/deletion.js";
import { createForgeService, type ForgeService } from "../forge/forge-service.js";
import { forgeAccountsProjector } from "../forge/forge-store.js";
import { createCredentialRoute } from "../forge/credential-route.js";
import { forgeMethods } from "../forge/methods.js";
import type { ManagedGh } from "../forge/gh.js";
import type { ForgeFetch } from "../forge/providers.js";
import type { KeyManagerRegistry } from "../key-managers/registry.js";
import { forkRewindMethods } from "../sessions/fork-rewind.js";
import { groupMethods } from "../sessions/group-methods.js";
import { sessionMethods } from "../sessions/methods.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { knownRepositoryIdentities } from "../sessions/session-tables.js";
import { createTerminalService } from "../terminals/service.js";
import type { TerminalsOptions } from "../terminals/terminals.js";
import { workspaceMethods } from "../workspace/methods.js";
import { createWorkspaceResolver, type WorkspaceResolver, type WorkspaceSettings } from "../workspace/resolver.js";
import { workspaceRoots } from "../workspace/roots.js";
import { createSettleSweep } from "../sessions/settle-sweep.js";
import { settingsMethods } from "../settings/methods.js";
import { setupMethods } from "../setup/methods.js";
import { environmentStateChecks } from "../setup/state-checks.js";
import { readSettings, settingsProjector } from "../settings/settings-store.js";
import type { SubscriptionHooks } from "../wire/subscriptions.js";
import { createWire } from "../wire/wire.js";
import { systemClock, type Clock } from "./clock.js";
import { createCloserStack } from "./closers.js";
import { defaultDataDirectory, prepareDataDirectory } from "./data-directory.js";
import { createHttpSurface, sendJson, type Address, type HttpRoutes } from "./http.js";
import { ensureSigningKey, loadOrCreateRecord, type EnvironmentRecord } from "./identity.js";
import { LOOPBACK, bindList, tailscaleDetector, type BoundInterface, type InterfaceDetector } from "./interfaces.js";
import { processLauncherChannel, type LauncherChannel } from "./launcher.js";
import { processContainerDetector, type ContainerDetector } from "./container.js";
import { createLifecycle, type DrainOutcome } from "./lifecycle.js";
import { createMethodTable, type MethodTable } from "./methods.js";
import type { MemoryRunRegistry } from "./run-registry.js";
import { processUserCheck, refusePrivilegedUser, type UserCheck } from "./user.js";
import { fileVault, holdVault, VAULT_FILE, type Vault } from "./vault.js";

/** The harness version the environment reports: its own package's, read from `src/` and `dist/` alike. */
export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * The port an environment listens on when none is given. A chosen default, not
 * decided on a ticket: saved connections need a stable port, and a second
 * environment on one machine passes its own.
 */
export const DEFAULT_PORT = 7433;

/** Where each repository's auto-memory directory lives in the data directory, shared by every account (ADR 0018). */
export const AUTO_MEMORY_DIRECTORY = "auto-memory";

/** The database file in the data directory, named where the launcher, which snapshots it, reads it too. */
export { DATABASE_FILE };

/**
 * The startup order the env spec fixes ("Lifecycle"), after the root refusal
 * that precedes them all. Readiness turns `ready` only after the last.
 */
export const STARTUP_STEPS = [
  "data-directory",
  "database",
  "projectors",
  "identity",
  "adapter-host",
  "listen",
  "prepared",
] as const;
export type StartupStep = (typeof STARTUP_STEPS)[number];

/** How far startup has got, for the test hooks. */
export interface StartupProgress {
  /** The listener's address, once the `listen` step has bound it. */
  readonly address: Address | undefined;
}

/** Test hooks: `beforeStep` runs, and is awaited, before each startup step; a throw fails that step. */
export interface StartupHooks {
  beforeStep?(step: StartupStep, progress: StartupProgress): void | Promise<void>;
}

/** A startup step failed. Everything opened before it was closed, and the wire never opened: `prepared` was never signalled, or never committed. */
export class StartupError extends Error {
  readonly step: StartupStep;

  constructor(step: StartupStep, cause: unknown) {
    super(`Startup failed at the ${step} step: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "StartupError";
    this.step = step;
  }
}

export interface EnvironmentOptions {
  /** The data directory; preset: the platform's user state directory (`defaultDataDirectory`). */
  readonly dataDir?: string;
  /**
   * The harness version the environment runs as: what discovery, health,
   * `prepared`, `environment.started` and `updates.status` report. Preset:
   * the package's (`HARNESS_VERSION`); a test starts one data directory as
   * two versions with it.
   */
  readonly harnessVersion?: string;
  /** The loopback port; preset `DEFAULT_PORT`; 0 picks a free one. */
  readonly port?: number;
  /** The name a new environment is created with; preset: the machine's hostname. An existing environment keeps its own. */
  readonly name?: string;
  /** The environment's own tailnet name, which the Host check accepts while the tailnet address is bound. Preset: the detector's. */
  readonly tailnetName?: string;
  /** What is found to bind beside loopback. Preset: the `tailscale` CLI (`tailscaleDetector`); tests pass their own. */
  readonly interfaces?: InterfaceDetector;
  /** The tailnet setting: bind the Tailscale address. Preset: on when an address is found. The settings store (#117) will hold it. */
  readonly bindTailnet?: boolean;
  /** The LAN setting: bind `lanAddress`, which must then be given. Preset: off. The settings store (#117) will hold it. */
  readonly bindLan?: boolean;
  /** The LAN address bound when `bindLan` is on. Never the wildcard address. */
  readonly lanAddress?: string;
  /** Preset: the running process's user (`processUserCheck`). */
  readonly user?: UserCheck;
  /** Preset: the IPC channel of a launcher that spawned the environment, else nothing (`processLauncherChannel`). */
  readonly launcher?: LauncherChannel;
  /** Preset: the file vault in the data directory. Every entry is registered with the scrub registry while the environment holds it. */
  readonly vault?: Vault;
  /** Registered and caught up from their cursors in the `projectors` step, after the environment's own (the session list). */
  readonly projectors?: readonly Projector[];
  /**
   * The environment's time: timestamps, the ping interval, the auth timeout,
   * token expiry and the terminal UI sweep. Preset: `systemClock`; tests pass
   * a manual one.
   */
  readonly clock?: Clock;
  readonly hooks?: StartupHooks;
  /** Test seams for subscriptions: hold a catch-up, slow a socket down. */
  readonly subscriptionHooks?: SubscriptionHooks;
  /** The run registry the adapter host fills and the idle rule and the drain read, with the drain's admission gate. Preset: a fresh one. */
  readonly runs?: MemoryRunRegistry;
  /**
   * The scrub registry (ADR 0011): the values the environment holds as
   * secrets, its vault's entries among them from start, replaced with
   * `[redacted]` in every event payload as the log appends it and in every
   * line written to the process's standard error while the environment
   * runs. Preset: a fresh one.
   */
  readonly scrub?: ScrubRegistry;
  /** Whether this is a container; with no launcher present too, updates are managed outside. Preset: `processContainerDetector`. */
  readonly containerDetector?: ContainerDetector;
  /** The adapters the adapter host holds, one per provider. Preset: the Claude adapter, with auto memory under the data directory. */
  readonly adapters?: readonly Adapter[];
  /**
   * Accounts carried over from configuration (#119): adopted in place into
   * the account store, under their own ids, the first time the environment
   * starts with a store that has never held an account; ignored after. The
   * store is what runs go through. Preset: none.
   */
  readonly accounts?: readonly ConfiguredAccount[];
  /**
   * The sign-in director `accounts.add` hands a new account to and the
   * `accounts.signin.*` methods drive. Preset: the director (#135) over
   * Claude's sign-in program, run as `signInProcess` says.
   */
  readonly signIn?: SignInDirectorFactory;
  /**
   * How the preset director's sign-ins run (#135): the process spawner, the
   * environment a sign-in inherits before the scrub, the bundled binary, the
   * managed tool and the working directory. Preset: `node:child_process`,
   * this process's environment, the SDK's bundled binary, `claude` on the
   * PATH, the home directory.
   */
  readonly signInProcess?: {
    readonly spawn?: SignInSpawn;
    readonly hostEnv?: HostEnvironment;
    readonly bundled?: string | null;
    readonly managedTool?: () => string | null;
    readonly cwd?: string;
  };
  /** How long an account's status or model probe may take. Preset: `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
  /** How long a plan-usage read may take before the reading answers unavailable. Preset: `USAGE_READ_TIMEOUT_MS`. */
  readonly usageReadTimeoutMs?: number;
  /**
   * The idle time of a provider process, in minutes, read each time a wait
   * begins. Preset: the `providers.processIdleMinutes` setting as the
   * settings store holds it (its preset, 30, until it is set); a test passes
   * its own.
   */
  readonly processIdleMinutes?: () => number;
  /** The adapter host's seams other workstreams fill; each has a preset (`adapter/seams.ts`). */
  readonly adapterSeams?: {
    readonly toolServers?: ToolServerFactory;
    readonly instructions?: InstructionComposer;
    /** The broker's automatic answers; preset: the unattended and bypass rules (#131, `permissions/auto-answer.ts`). */
    readonly autoAnswer?: PromptAutoAnswer;
    /** Preset: the policy resolver on the environment's permission settings (#129) and its containment probe (#133). */
    readonly resolvePolicy?: PolicySeam;
    /** The tool gate's rules; preset: the denylist's (#132, `permissions/denylist-gate.ts`). */
    readonly gateRules?: readonly ToolGateRule[];
  };
  /**
   * What this environment can enforce (#133), probed once as the adapter
   * host starts: its capability flags, the containment default's preset and
   * every run's containment follow from it. Preset: the probe of the running
   * machine (`containment-probe.ts`); tests script it.
   */
  readonly probeContainment?: () => Promise<ContainmentProbe>;
  /** How terminals start: the pty, the shell, the base environment. Preset: `node-pty`, the user's login shell, the clean base (`terminals/`). */
  readonly terminals?: Omit<TerminalsOptions, "clock">;
  /**
   * The resolver `sessions.create` and the completions surface give a new
   * session its workspace through (#321). Preset: the environment's
   * (`workspace/resolver.ts`); tests script it.
   */
  readonly workspaceResolver?: WorkspaceResolver;
  /**
   * What the environment's resolver reads beyond its data directory (#325):
   * the workspace roots later workstreams declare beside the data
   * directory's scratch and worktrees, which are exempt from the denylist's
   * data-directory preset as they are; the home `~` stands for; whether a
   * directory can be read; how long git gets. Each has a preset.
   */
  readonly workspaces?: WorkspaceSettings;
  /**
   * The command line that runs the `agent-harness` binary before its verb
   * (#314): git names it, with `git-credential <slug>`, as its credential
   * helper. `serve` passes the one it runs as; the launcher's stable shim
   * (#338) takes its place once it exists. Absent, the harness's git refuses
   * an origin a forge account covers.
   */
  readonly harnessCommand?: readonly string[];
  /** How the ForgeService reaches a forge (#310). Preset: the global `fetch`; tests route github.com's API to their fake forge. */
  readonly forgeFetch?: ForgeFetch;
  /** How long one call to a forge, and one verification of a forge account, may take (#311). Preset: `FORGE_CALL_TIMEOUT_MS`, ADR 0031's ten seconds. */
  readonly forgeTimeoutMs?: number;
  /**
   * The environment's own `gh`, behind the Managed tools seam the registry
   * (#91) replaces (#312). Preset: the `gh` on this process's PATH; tests
   * put a fake one on a PATH of their own.
   */
  readonly gh?: ManagedGh;
  /** The key-manager registry's resolve seam, which #91 fills (#312). Preset: no key-manager connection; tests script one. */
  readonly keyManagers?: KeyManagerRegistry;
  /**
   * Reads the bundled Claude Code's version, which `updates.status` answers;
   * called once, the first time it is asked for. Preset: the bundled
   * binary's `--version` (`adapters/claude/version.ts`); tests script it.
   */
  readonly claudeCodeVersion?: () => Promise<string | null>;
}

/** Who starts a run that no client session starts: a routine, a bot, or the completions surface. */
type ActorOfRun<K extends RunActor["kind"]> = Extract<RunActor, { readonly kind: K }>;

/**
 * A run an actor that is no client session starts: the session, who (a
 * routine or a bot by its id, which the log names it by, since its name can
 * change; the completions surface), the message it starts with, and a mode
 * of its own if it names one.
 */
export type ActorRunRequest = {
  readonly sessionId: string;
  readonly text: string;
  readonly mode?: Mode;
} & (
  | { readonly actor: ActorOfRun<"routine" | "bot">; readonly actorId: string }
  | { readonly actor: ActorOfRun<"completions">; readonly actorId?: undefined }
);

/** Where a run an actor starts comes from, and who the log says started it: a bot's runs are its routines' (ADR 0008). */
const startedBy = (request: ActorRunRequest): { readonly origin: RunOrigin; readonly actor: string } => {
  const { actor } = request;
  if (actor.kind === "completions") return { origin: "completions", actor: formatActor({ kind: "system", id: "completions" }) };
  const id = request.actorId ?? "";
  return actor.kind === "routine"
    ? { origin: "routine", actor: formatActor({ kind: "routine", id }) }
    : { origin: "routine", actor: formatActor({ kind: "system", id: `bot:${id}` }) };
};

/** A running environment. */
export interface EnvironmentHandle {
  readonly id: string;
  readonly name: string;
  readonly dataDir: string;
  /** Where the loopback listener is bound. */
  readonly address: Address;
  /** Every address a listener is bound to, loopback first, all on one port. */
  readonly addresses: readonly Address[];
  /** `local-only` when only loopback is bound, `tailnet` otherwise. */
  readonly authPolicy: AuthPolicy;
  readiness(): EnvironmentReadiness;
  /** What `environment.status` answers: readiness, idle or busy or draining, and whether updates are managed outside. */
  status(): EnvironmentStatus;
  /**
   * Starts the drain, or joins the one under way, and settles when it has
   * ended and the environment has closed. `serve` calls it on SIGTERM with
   * `signal`; `environment.drain` and the launcher's drain query start the
   * same drain.
   */
  drain(trigger: DrainTrigger): Promise<DrainOutcome>;
  /** Settles when a drain, whatever started it, has ended and the environment has closed: `serve` exits then. */
  readonly drained: Promise<DrainOutcome>;
  /**
   * The methods the wire dispatches into after its scope check: every
   * registry method, with its handler once one is registered. A feature that
   * starts after the environment registers its handlers here.
   */
  readonly methods: MethodTable;
  /** The listener's route table, behind the Host check. */
  readonly http: HttpRoutes;
  /** Issuing (by an in-process pairing) and revoking client sessions from the embedding process. */
  readonly clientSessions: ClientSessionIssuer;
  /**
   * Starts a run on a session for an actor that is no client session (a
   * routine, a bot, the completions surface), as `runs.start` does for a
   * client session: its policy resolved for that actor (#129; attended or
   * not, the unattended default), recorded, then launched once it has
   * committed. The seam the routines (#92) and the completions surface
   * (#139) start their runs through, and the tests of unattended runs
   * (#131). Throws the refusal `runs.start` would answer.
   */
  startRun(request: ActorRunRequest): { readonly runId: string; readonly messageId: string };
  /** How many WebSocket sockets are open on the wire. */
  sockets(): number;
  /** How many subscriptions are open on the wire, across every socket: a count for tests and diagnostics. */
  subscriptions(): number;
  /**
   * The event log: the one sink, whose committed events reach every
   * subscription to their stream. The environment opened it and closes it.
   */
  readonly log: EventLog;
  /**
   * The ForgeService (#310): the one way to a forge, which the banks,
   * skills, routines, the launcher, Set up and the state import call in
   * process, reading a forge account's credential per operation (#312).
   */
  readonly forge: ForgeService;
  /**
   * Stops the sweep, removes the bootstrap grant file, says `bye: draining`
   * to every socket and closes it (1001), stops listening, closes the event log, then closes the
   * launcher channel, each even when another fails. Idempotent; after a failure, calling it
   * again retries what did not close.
   */
  close(): Promise<void>;
}

/**
 * The host a pairing link names: the tailnet name when the tailnet address is
 * bound and has one, else the first address bound beyond loopback, else
 * loopback, which pairs a client on this machine only.
 */
const linkHost = (listening: readonly { readonly address: Address; readonly interface: BoundInterface }[], tailnetName: string | undefined): string => {
  const tailnet = listening.find((entry) => entry.interface === "tailnet");
  if (tailnet && tailnetName !== undefined) return tailnetName;
  const host = (listening.find((entry) => entry.interface !== "loopback") ?? listening[0])?.address.host ?? LOOPBACK;
  return formatHostPort(host);
};

/**
 * The running user's name from the passwd database, which the denylist reads
 * `~<name>` as the home directory for. None for a uid with no entry (a
 * container's arbitrary `--user`), where `userInfo` throws on POSIX and no
 * shell expands a `~<name>` either.
 */
const passwdName = (): string | undefined => {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
};

/**
 * Starts an environment: refuses root before anything is created, then runs
 * the startup steps in order. Discovery and health are routed before the bind,
 * so they answer `starting` from the first byte; readiness is `ready` only
 * once `prepared` has been signalled and, under a launcher, committed. A
 * failed step closes what was opened, signals nothing, and rejects with a
 * `StartupError` naming the step.
 */
export const startEnvironment = async (options: EnvironmentOptions = {}): Promise<EnvironmentHandle> => {
  refusePrivilegedUser(options.user ?? processUserCheck());
  // Past the refusal, the environment does not run as root (ADR 0006): what `permissions.settings.get` answers as
  // `isRoot`, and the not-root line the Permissions and Your machines steps' checks read from it (#141).
  const isRoot = false;

  // Absolute once, here: a relative `--data-dir` would make the denylist's data-directory preset and its exemption relative paths (#132).
  const dataDir = absolutePath(options.dataDir ?? defaultDataDirectory());
  const harnessVersion = options.harnessVersion ?? HARNESS_VERSION;
  const clock: Clock = options.clock ?? systemClock;
  const now = () => clock.now();
  const scrub = options.scrub ?? createScrubRegistry();
  const launcher = options.launcher ?? processLauncherChannel();
  // Under a launcher the environment can update itself to a client's version (ADR 0007); under a foreground `serve` it
  // cannot, and `updates.status` says why. Managed outside, the flag waits for the host-side updater's poll (#348).
  const capabilities: CapabilityFlags = launcher.present() ? ["self-update"] : [];
  // Set when the listeners are bound: local-only until then, which is what binding loopback alone means.
  let authPolicy: AuthPolicy = "local-only";
  // The name the Host check admits: set only once the tailnet address is bound.
  let tailnetName: string | undefined;

  let readiness: EnvironmentReadiness = "starting";
  let address: Address | undefined;
  const closers = createCloserStack();
  // Pushed first, so it is let go last: every line the environment writes to its standard error passes the scrub
  // registry from here to the end of its close, and of a failed start's (ADR 0011).
  closers.push(scrubDiagnosticOutput((text) => scrub.scrub(text)));
  // Pushed next, so it closes after everything else the environment opens, and only the scrub above is let go after it:
  // after the listener and the event log, and after a failed start too.
  closers.push(() => launcher.close());
  // Concurrent closes share one attempt; a close after a failed one retries what did not close.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => (closing ??= closers.closeAll().finally(() => (closing = undefined)));

  const step = async <T>(name: StartupStep, work: () => T | Promise<T>): Promise<T> => {
    try {
      await options.hooks?.beforeStep?.(name, { address });
      return await work();
    } catch (error) {
      await closers.closeAll().catch((closeError: unknown) => console.error("Closing after a failed start failed:", closeError));
      throw new StartupError(name, error);
    }
  };

  await step("data-directory", () => prepareDataDirectory(dataDir));

  const log: EventLog = await step("database", () => {
    const opened = openEventLog({ path: join(dataDir, DATABASE_FILE), clock: now, scrub: (text) => scrub.scrub(text) });
    closers.push(() => opened.close());
    return opened;
  });

  await step("projectors", () => {
    for (const projector of [
      sessionListProjector,
      runsProjector,
      settingsProjector,
      permissionsProjector,
      accountsProjector,
      forgeAccountsProjector,
      ...(options.projectors ?? []),
    ]) {
      log.registerProjector(projector);
    }
  });

  // Where pairing links point: set when the listeners are bound, before any request is served.
  let linkOrigin: string | undefined;
  // The permission settings (#129), read where they are used: inside a command, in its transaction.
  // What containment can enforce here: probed as the adapter host starts, before any client can ask (#133).
  let containment: ContainmentReport = UNPROBED_REPORT;
  const settingsPresets = () => ({ "permissions.containment.default": presetContainmentDefault(containment) }) as const;
  const permissionSettings = () => readPermissionSettings({ all: (sql, ...params) => log.read(sql, ...params) }, settingsPresets());

  // The record, the signing key and the auth tables: client sessions and pairings are read once, here, into memory.
  // The vault is taken hold of first, so every entry is registered for scrubbing before anything reads it (ADR 0011).
  // The forge accounts' store (#310) starts in this step too, after the client sessions whose labels a token handed over
  // from a client's gh records (#312): each stored token is registered with its Basic-auth form, and the vault entries of
  // forge accounts that are gone are deleted, before anything can read them.
  const { record, clientSessions, pairings, accessLog, forge } = await step("identity", async () => {
    const name = (options.name ?? hostname()).trim();
    if (!name) throw new Error("An environment's name cannot be empty.");
    const loaded: EnvironmentRecord = loadOrCreateRecord(dataDir, name, now);
    const vault = await holdVault(options.vault ?? fileVault(join(dataDir, VAULT_FILE)), scrub);
    const key = await ensureSigningKey(vault);
    const access = createAccessLog(log, loaded.id);
    const loadedClientSessions: ClientSessions = createClientSessions({
      table: log.clientSessions,
      accessLog: access,
      key,
      environmentId: loaded.id,
      clock,
    });
    const loadedPairings: Pairings = createPairings({
      table: log.pairings,
      clientSessions: loadedClientSessions,
      accessLog: access,
      clock,
      link: (code) => {
        if (linkOrigin === undefined) throw new Error("A pairing link was asked for before the environment was bound.");
        return pairingLink(linkOrigin, code);
      },
      defaultCeiling: () => permissionSettings()["permissions.defaultCeiling"],
    });
    const forgeService: ForgeService = createForgeService({
      log,
      clock,
      environmentId: loaded.id,
      vault,
      scrub,
      clientSessionLabel: (id) => loadedClientSessions.list({ live: false }).find((session) => session.id === id)?.label,
      ...(options.forgeFetch !== undefined && { fetch: options.forgeFetch }),
      ...(options.forgeTimeoutMs !== undefined && { callTimeoutMs: options.forgeTimeoutMs }),
      knownRepositories: () => knownRepositoryIdentities({ all: (sql, ...params) => log.read(sql, ...params) }),
      ...(options.gh !== undefined && { gh: options.gh }),
      ...(options.keyManagers !== undefined && { keyManagers: options.keyManagers }),
      ...(options.harnessCommand !== undefined && { harnessCommand: options.harnessCommand }),
      // Where the credential helper asks: the loopback listener, bound after this step.
      address: () => address,
    });
    closers.push(() => forgeService.close());
    await forgeService.start();
    capabilities.push("forge");
    return { record: loaded, clientSessions: loadedClientSessions, pairings: loadedPairings, accessLog: access, forge: forgeService };
  });

  // Where the denylist reads paths from (#132): the user's home for `~` (and for `~<the user's name>`), the file system's
  // links, and the directories inside the data directory where runs work, which the data directory's preset leaves out: the
  // containment directories (#133's) and every workspace root, the scratch workspaces a completions request runs in (#140,
  // now its every call is gated), the worktrees and any root a later workstream declares (#325).
  const user = passwdName();
  const roots = workspaceRoots(dataDir, options.workspaces?.roots);
  const denylistContext: Omit<DenylistContext, "denylist"> = {
    home: homedir(),
    exempt: [join(dataDir, CONTAINMENT_DIRECTORY), ...roots.all],
    ...(user !== undefined && { user }),
  };
  const readDenylistNow = () => readDenylist({ all: (sql, ...params) => log.read(sql, ...params) });

  // The SDK session store (#137): the provider's transcripts beside the log, which every Claude run passes and resumes from.
  const providerStore: ProviderTranscriptStore = createProviderTranscriptStore({ log, clock });

  // Each session's scratch and temporary directories, under the data directory; removed once the session's purge commits, off the log's path.
  const sessionDirectories = containmentDirectories(join(dataDir, CONTAINMENT_DIRECTORY));
  closers.push(
    log.subscribe((event) => {
      if (event.streamKind !== SESSION_STREAM_KIND || event.type !== "session.purged") return;
      const sessionId = event.streamId;
      setImmediate(() => {
        sessionDirectories.remove(sessionId).catch((error: unknown) => console.error(`Removing the containment directories of the purged session ${sessionId} failed:`, error));
      });
    }),
  );

  // Client-tool passthrough (#139): the calls runs make to a completions caller's tools, parked until the caller answers,
  // and the `client` tool server the factory adds for a run whose request declared tools. Closed after the host, whose
  // close ends every run (and so lets go of what each left parked).
  const passthrough = createPassthrough({ log, clock });
  closers.push(() => passthrough.close());
  const seamServers = options.adapterSeams?.toolServers ?? noToolServers;

  // The account store and the adapter host: the adapters, the accounts' sign-in states read through their probes, the run registry.
  const { host, accounts } = await step("adapter-host", async () => {
    // The denylist's presets on first start (#132), before any run can be gated.
    seedDenylist({ log, stream: accessLog.stream, dataDir });
    // First the recovery sweep: a run the log left without an end was cut by the last stop, and is ended before anything can read it.
    const recovered = recoverCutRuns({ log, clock });
    if (recovered.length > 0) console.error(`The recovery sweep ended ${recovered.length} run(s) a restart cut: ${recovered.join(", ")}.`);
    // Then the queued messages' attachment bytes, read back from the stage, so a message the sweep handed back keeps them (#185).
    const attachmentStage = createAttachmentStage(join(dataDir, ATTACHMENTS_DIRECTORY));
    const stagedAttachments = recoverStagedAttachments({ log, stage: attachmentStage });
    const adapters = options.adapters ?? [createClaudeAdapter({ clock, autoMemoryRoot: join(dataDir, AUTO_MEMORY_DIRECTORY), sessionStore: providerStore })];
    // The probe never fails a start: a probe that throws leaves nothing but off, and says why.
    let probed: ContainmentReport;
    try {
      probed = containmentReport(await (options.probeContainment ?? (() => probeContainment()))());
    } catch (error) {
      console.error("The containment probe failed; only off is offered:", error);
      probed = failedProbeReport(error);
    }
    // A workspace level needs an adapter that hands it to its provider's sandbox, as well as the machine (#133).
    containment = withAdapters(
      probed,
      adapters.map((adapter) => adapter.descriptor),
    );
    capabilities.push(...containmentFlags(containment));
    const settings = () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) });
    // The sign-in director (#135): Claude accounts sign in through the bundled binary, else the managed tool `claude`.
    const signInProcess = options.signInProcess ?? {};
    const signIn =
      options.signIn ??
      createSignInDirector({
        log,
        clock,
        environmentId: record.id,
        programs: {
          [CLAUDE_PROVIDER]: claudeSignInProgram({
            bundled: signInProcess.bundled !== undefined ? signInProcess.bundled : bundledExecutable(),
            ...(signInProcess.hostEnv !== undefined && { hostEnv: signInProcess.hostEnv }),
            ...(signInProcess.managedTool !== undefined && { managedTool: signInProcess.managedTool }),
          }),
        },
        ...(signInProcess.spawn !== undefined && { spawn: signInProcess.spawn }),
        ...(signInProcess.cwd !== undefined && { cwd: signInProcess.cwd }),
      });
    // The account store (#134): the configured accounts carried over once, then every account's status read, and read
    // again at most every fifteen minutes; its reads before the wire opens notice nothing.
    const store: AccountService = createAccountService({
      log,
      clock,
      adapters,
      environmentId: record.id,
      ownedRoot: join(dataDir, ACCOUNTS_DIRECTORY),
      configured: options.accounts ?? [],
      defaults: () => {
        const values = settings();
        return { account: values["accounts.defaultAccount"], modelFamily: values["accounts.defaultModelFamily"], effort: values["accounts.defaultEffort"] };
      },
      signIn,
      ...(options.probeTimeoutMs !== undefined && { probeTimeoutMs: options.probeTimeoutMs }),
    });
    closers.push(() => store.close());
    await store.start();
    const created = createAdapterHost({
      log,
      clock,
      attachmentStage,
      stagedAttachments,
      ...(options.runs !== undefined && { runs: options.runs }),
      adapters,
      accounts: store,
      // The policy resolver on the permission settings, and each client session's ceiling as it is now (#129).
      resolvePolicy: ({ actor, requested, accountModes, containment: level }) =>
        resolvePolicy({
          actor,
          requested,
          ceiling: actor.ceiling,
          accountModes,
          settings: policySettings(permissionSettings(), readStoredContainmentDefault({ all: (sql, ...params) => log.read(sql, ...params) })),
          containment: level,
          enforceable: containment,
        }),
      containmentDirectories: sessionDirectories,
      ceilingOf: (id) => clientSessions.ceiling(id),
      // The unattended and bypass rules, and the TTL a prompt that parks is fixed with (#131).
      autoAnswer,
      // The tool gate's rules (#132): the denylist, read as it is when each call is made.
      gateRules: [denylistRule({ ...denylistContext, denylist: readDenylistNow })],
      // What an unattended run projects onto its provider's own rules (#140), read as it starts.
      providerDenylist: () => providerDenylist(readDenylistNow(), denylistContext),
      promptTtlMs: () => parkedPromptTtlMs(permissionSettings()["permissions.parkedPrompt.ttl"]),
      processIdleMinutes: options.processIdleMinutes ?? (() => settings()["providers.processIdleMinutes"]),
      ...options.adapterSeams,
      // The seam's servers, then the caller's own tools as the `client` server (#139).
      toolServers: (scope) => [...seamServers(scope), ...passthrough.toolServers(scope)],
    });
    // Closed before the event log, so a run the close ends has its end appended (drained when a drain's cap cut it), and
    // before the launcher's channel, so the launcher hears the environment go only once every provider process has
    // stopped, or has been killed after the stop timeout.
    closers.push(() => created.close(readiness === "draining" ? "drained" : "disposed"));
    return { host: created, accounts: store };
  });

  // Plan usage (#136): one reading per account, read through the host and kept six minutes, a run's plan.limit folded in
  // from the log, usage.updated on a change; heard from here on, before the wire opens.
  const usagePool = createUsagePool({
    log,
    clock,
    environmentId: record.id,
    accounts,
    host,
    ...(options.usageReadTimeoutMs !== undefined && { readTimeoutMs: options.usageReadTimeoutMs }),
  });
  closers.push(() => usagePool.close());

  const surface = createHttpSurface({ tailnetName: () => tailnetName });
  const noStore = { "cache-control": "no-store" };
  surface.route("GET", DISCOVERY_PATH, (_request, response) => {
    const document: DiscoveryDocument = {
      environmentId: record.id,
      environmentName: record.name,
      harnessVersion,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      authPolicy,
      readiness,
    };
    sendJson(response, 200, document, noStore);
  });
  surface.route("GET", HEALTH_PATH, (_request, response) => {
    const health: HealthDocument = { status: readiness, version: harnessVersion };
    sendJson(response, 200, health, noStore);
  });

  // The environment's own notices: environment.subscribe's stream, whose snapshot is the status.
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: record.id };
  // A prompt that parks, and its answer, are told to every client there (#130); stopped before the event log closes.
  closers.push(startPromptNotices({ log, stream: environmentStream }));
  const detector = options.containerDetector ?? processContainerDetector();
  // A container with no launcher: a host-side updater manages its updates, and it never updates itself (ADR 0007).
  const updatesManagedOutside = detector.inContainer() && !launcher.present();
  // The purge: `sessions.purge` runs it at once, the minute sweep for every session past its grace period.
  const deletion = createDeletion({ log, transcripts: host.transcripts, providerStore });
  // The terminals (#124): their output never enters the log; closed before the log is, and on a session's deletion.
  const terminalService = createTerminalService({ log, clock, ...options.terminals });
  closers.push(() => terminalService.close());
  const lifecycle = createLifecycle({
    clock,
    runs: host.runs,
    log,
    stream: environmentStream,
    updatesManagedOutside,
    // The idle window (#342): how long nothing may start or end, and how long a parked prompt counts as busy.
    idleWindowMs: () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["updates.idleWindowMinutes"] * 60_000,
    // A terminal whose shell runs a command holds the environment busy as a run does (#343).
    terminalRunning: () => terminalService.terminals.commandRunning(),
    readiness: () => readiness,
    onDraining: () => {
      readiness = "draining";
      // New runs are refused before any process stops, so none starts on a process the drain is stopping.
      host.runs.refuseNewRuns();
      // Idle provider processes stop now, busy ones as their turns end; a failure here never stops the drain.
      try {
        host.drain();
      } catch (error) {
        console.error("Stopping the idle provider processes for the drain failed; the drain goes on:", error);
      }
    },
    // An update's drain that waited its runs out ends with bye: updating to every client and the launcher's switch (#343);
    // one the environment's close cut short closes as any drain does.
    close: async (ended) => {
      try {
        if (ended.trigger === "update" && ended.endedBy !== "closed") {
          await wire.close({ reason: "updating", message: "The environment is updating to a new version and will be back shortly." });
          await updates.switchOver();
        }
      } finally {
        await close();
      }
    },
  });
  // The update coordinator (#343): the pending update, read back from the log, its wait, its drain and the switch.
  const updates = createUpdateCoordinator({
    log,
    clock,
    stream: environmentStream,
    dataDir,
    environmentName: record.name,
    harnessVersion,
    launcher,
    runs: host.runs,
    host,
    activity: () => lifecycle.status().activity,
    deferralCapMs: () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) })["updates.deferralCapHours"] * 60 * 60_000,
    drain: (cause) => void lifecycle.drain("update", cause),
  });
  // The shelf's sweep (#117): started once the environment is ready; a settings change runs it from the change's commit.
  const settleSweep = createSettleSweep({ log, clock });
  // A new session's workspace, from the request `sessions.create` or the completions surface makes (#321).
  const workspaceResolver = options.workspaceResolver ?? createWorkspaceResolver({ ...options.workspaces, log, dataDir, roots });
  const table = createMethodTable({
    ...lifecycle.handlers,
    "environment.subscribe": () => lifecycle.source,
    // The rebuild joins the command's transaction, so it and the receipt commit together.
    "environment.rebuildProjections": () => ({
      aggregate: environmentStream,
      result: { projectors: [...log.rebuildProjections()], sequence: log.head() },
    }),
    // The generic settings (#117), on the environment's settings stream.
    ...settingsMethods({ log, environmentId: record.id, onChange: (keys) => settleSweep.settingsChanged(keys), presets: settingsPresets() }),
    ...accessMethods({ pairings, clientSessions, accessLog }),
    ...sessionMethods({
      log,
      clock: now,
      deletion,
      resolver: workspaceResolver,
      validateRunParameters: host.validateSessionInput,
      clampSessionMode: sessionModeClamp({ host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    }),
    ...groupMethods({ log, clock: now }),
    // Fork, rewind and the subagent transcript (#137), beside the session commands.
    ...forkRewindMethods({
      log,
      host,
      clock,
      store: providerStore,
      validateRunParameters: host.validateSessionInput,
      clampSessionMode: sessionModeClamp({ host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    }),
    ...runMethods({ log, host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    ...permissionMethods({ log, host, accessLog, clock, environmentId: record.id, ceilingOf: (id) => clientSessions.ceiling(id), containment, isRoot }),
    ...promptMethods({ log, host, environmentId: record.id }),
    ...reviewMethods({ log, environmentId: record.id }),
    ...denylistMethods({ log, accessLog, dataDir, context: denylistContext }),
    // Set up's health checks (ADR 0031; #141): each registered step's, on this environment.
    ...setupMethods({ log, clock, presets: settingsPresets(), stateChecks: environmentStateChecks({ log, containment, isRoot, dataDir }) }),
    ...processMethods({ log, host }),
    ...accountMethods({ accounts, host }),
    ...forgeMethods(forge),
    ...usageMethods({ pool: usagePool, accounts, clock }),
    ...terminalService.handlers,
    ...workspaceMethods({ log }),
    // What runs, who manages its updates and what is installed, and the update settings (#342).
    ...updateMethods({
      log,
      environmentId: record.id,
      harnessVersion,
      launcher,
      managedOutside: updatesManagedOutside,
      coordinator: updates,
      claudeCodeVersion: options.claudeCodeVersion ?? (() => readClaudeCodeVersion({ executable: bundledExecutable() })),
    }),
  });

  // The two exchanges and the wire are routed before the bind; all three refuse work until the gate below.
  const grant = createBootstrapGrant({
    dataDir,
    clientSessions,
    atomically: accessLog.atomically,
    rateLimiter: createRateLimiter({ clock }),
    readiness: () => readiness,
  });
  surface.route("POST", BOOTSTRAP_PATH, grant.exchange);
  surface.route(
    "POST",
    PAIR_PATH,
    pairRoute({ pairings, atomically: accessLog.atomically, rateLimiter: createRateLimiter({ clock }), readiness: () => readiness }),
  );
  // The credential route (#314): what git's credential helper asks, over loopback, with a run-scoped secret; no client session.
  surface.route("POST", GIT_CREDENTIAL_PATH, createCredentialRoute({ forge, clock }));
  // The completions surface (#138): OpenAI's routes under /v1/ on the wire's port, for programs' client sessions.
  const completions = createCompletionsSurface({
    log,
    host,
    clock,
    clientSessions,
    readiness: () => readiness,
    // The account store (#134): every account it holds, by its label, with what the host would run it with.
    catalogue: {
      accounts: () =>
        accounts.list().flatMap((record) => {
          const facts = accounts.facts(record.id);
          return facts === null ? [] : [{ id: record.id, label: record.label, provider: record.provider, signedIn: facts.signedIn, models: facts.models }];
        }),
      defaultAccountId: () => accounts.defaultId(),
    },
    methods: table,
    passthrough,
    resolver: workspaceResolver,
  });
  surface.prefix(OPENAI_PATH_PREFIX, completions.handle);
  const wire = createWire({
    environment: record,
    capabilities,
    clientSessions: socketSessions(clientSessions, accessLog.atomically),
    methods: table,
    clock,
    log,
    ...(options.subscriptionHooks !== undefined && { subscriptionHooks: options.subscriptionHooks }),
  });
  surface.upgrade(WIRE_PATH, wire.upgrade);

  const bound = await step("listen", async () => {
    const interfaces = options.interfaces ?? tailscaleDetector();
    const tailscaleAddress = await interfaces.tailscaleAddress();
    const binds = bindList({ tailscaleAddress, bindTailnet: options.bindTailnet, bindLan: options.bindLan, lanAddress: options.lanAddress });
    closers.push(() => surface.close());
    // Loopback first: its port, chosen when 0 is asked for, is every other listener's.
    const listening: { address: Address; interface: BoundInterface }[] = [];
    for (const bind of binds) {
      const port = listening[0]?.address.port ?? options.port ?? DEFAULT_PORT;
      listening.push({ address: await surface.listen(bind.host, port), interface: bind.interface });
    }
    const [loopback] = listening;
    if (!loopback) throw new Error("No listener was bound.");
    address = loopback.address;
    authPolicy = listening.length > 1 ? "tailnet" : "local-only";
    if (listening.some((entry) => entry.interface === "tailnet")) tailnetName = options.tailnetName ?? (await interfaces.tailnetName());
    linkOrigin = `http://${linkHost(listening, tailnetName)}:${loopback.address.port}`;
    // Closed before the listeners, so no socket holds their close open.
    closers.push(() => wire.close());
    closers.push(() => grant.remove());
    grant.issue(loopback.address);
    return { address: loopback.address, addresses: listening.map((entry) => entry.address) };
  });

  // Closed before the wire and the listeners: an answer still open ends with a final chunk, never a bare close.
  closers.push(() => completions.close());

  // Under a launcher this waits for its `committed`: until then readiness stays `starting` and the wire serves no request,
  // so a trial the launcher rolls back never served a person. With no launcher it does not wait.
  await step("prepared", () => launcher.prepared(harnessVersion));
  readiness = "ready";
  // Only a start the launcher committed is noted, and before the wire opens, so a first subscriber finds it.
  try {
    log.append(
      environmentStream,
      [{ type: "environment.started", payload: { harnessVersion, protocolVersion: PROTOCOL_VERSION } }],
      { actor: formatActor({ kind: "system", id: "lifecycle" }) },
    );
  } catch (error) {
    await closers.closeAll().catch((closeError: unknown) => console.error("Closing after a failed start failed:", closeError));
    throw new StartupError("prepared", error);
  }
  // The settle (#344, #345): the update that began last gets its outcome from the version this start runs, and each run it cut
  // its mark and, where it can go on, its continuation, before any client can read the stream.
  updates.settle();
  // Deleted sessions whose grace period ran out while the environment was down go before any client can read them.
  try {
    deletion.purgeDue(clock.now());
  } catch (error) {
    console.error("The startup purge failed; the minute sweep will try again:", error);
  }
  // Then the SDK session store's rows under a purged session's key: a mirror write that raced its purge (#137).
  try {
    providerStore.sweepOrphans();
  } catch (error) {
    console.error("The session store's orphan sweep failed; the next start will try again:", error);
  }
  // The containment directories of sessions that are gone (purged while a removal failed, or before a crash), in the background.
  sessionDirectories
    .sweep((sessionId) => log.read("SELECT 1 FROM sessions WHERE id = ?", sessionId).length > 0)
    .catch((error: unknown) => console.error("Sweeping the containment directories of sessions that are gone failed:", error));
  // The shelf's sweep (#117): a pass now, before the wire opens, then every five minutes.
  closers.push(settleSweep.start());
  // The TTL's sweeper (#131): the prompts that expired while the environment was down now, before the wire opens, then every minute.
  closers.push(createTtlSweeper({ log, host, clock }).start());
  // Transcript compaction (#123): a pass now, before the wire opens, then once a day.
  closers.push(createCompactionSweep({ log, clock }).start());
  wire.open();
  launcher.onQuery((query) => lifecycle.answer(query));
  // The forge accounts' verifications (#311): each now, past the gate, then every fifteen minutes.
  forge.startVerifying();
  // The pending update's wait: every run-registry change, every minute, and its deferral cap (#343).
  closers.push(updates.start());
  // The minute sweep: expired pairings, idle `tui` local client sessions, receipts past their 30 days, and
  // deleted sessions past their grace period, each part tried even when one before it fails, and named when it does.
  const sweep = clock.setInterval(() => {
    const parts: readonly (readonly [string, () => unknown])[] = [
      [
        "The client session and pairing sweep",
        () =>
          accessLog.atomically((tx) => {
            clientSessions.sweep(tx);
            pairings.sweep(tx);
          }),
      ],
      ["The receipt prune", () => log.pruneReceipts(clock.now())],
      ["The purge sweep", () => deletion.purgeDue(clock.now())],
    ];
    for (const [name, part] of parts) {
      try {
        part();
      } catch (error) {
        console.error(`${name} failed:`, error);
      }
    }
  }, SWEEP_INTERVAL_MS);
  closers.push(() => sweep.cancel());
  // Runs first when the environment closes: a drain still waiting for runs stops waiting and ends `closed`.
  closers.push(() => lifecycle.stopWaiting());

  return {
    id: record.id,
    name: record.name,
    dataDir,
    address: bound.address,
    addresses: bound.addresses,
    authPolicy,
    readiness: () => readiness,
    status: () => lifecycle.status(),
    drain: (trigger) => lifecycle.drain(trigger).outcome,
    drained: lifecycle.drained,
    methods: table,
    http: { route: (method, path, handler) => surface.route(method, path, handler) },
    clientSessions: {
      issue(request) {
        const { code } = accessLog.atomically((tx) => pairings.create(tx, { scopes: request.scopes, ceiling: request.ceiling }, SYSTEM.owner));
        const exchanged = accessLog.atomically((tx) => pairings.exchange(tx, code, { kind: request.kind, label: request.label }));
        if (!exchanged.ok) throw new Error(`The in-process pairing was refused: ${exchanged.refusal}.`);
        return exchanged.credential;
      },
      revoke: (id) => accessLog.atomically((tx) => clientSessions.revoke(tx, id, "requested", SYSTEM.owner))?.changed === true,
    },
    startRun(request) {
      const { origin, actor } = startedBy(request);
      const started = log.atomically((tx) =>
        startRunIn(log, host, tx, { actor }, { sessionId: request.sessionId, actor: request.actor, origin, text: request.text, mode: request.mode }),
      );
      if (started.rejected !== undefined) throw new ContractError(started.rejected);
      return { runId: started.runId, messageId: started.messageId };
    },
    sockets: () => wire.sockets(),
    subscriptions: () => wire.subscriptions(),
    log,
    forge,
    close,
  };
};
