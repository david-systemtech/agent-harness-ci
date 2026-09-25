import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_PATH,
  DISCOVERY_PATH,
  ENVIRONMENT_STREAM_KIND,
  HEALTH_PATH,
  PAIR_PATH,
  PROTOCOL_VERSION,
  WIRE_PATH,
  formatHostPort,
  pairingLink,
  type AuthPolicy,
  type CapabilityFlags,
  type DiscoveryDocument,
  type DrainTrigger,
  type EnvironmentReadiness,
  type EnvironmentStatus,
  type HealthDocument,
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
import { createAdapterHost } from "../adapter/host.js";
import { ACCOUNTS_DIRECTORY, createAccountService, type AccountService, type ConfiguredAccount } from "../accounts/account-service.js";
import { accountsProjector } from "../accounts/account-store.js";
import { accountMethods } from "../accounts/methods.js";
import type { SignInDirectorFactory } from "../accounts/sign-in.js";
import { usageMethods } from "../accounts/usage-methods.js";
import { createUsagePool } from "../accounts/usage-pool.js";
import { processMethods } from "../adapter/processes-methods.js";
import { ATTACHMENTS_DIRECTORY, createAttachmentStage } from "../adapter/attachment-stage.js";
import { recoverCutRuns, recoverStagedAttachments } from "../adapter/recovery.js";
import type { InstructionComposer, PolicySeam, ToolServerFactory } from "../adapter/seams.js";
import type { PermissionBroker } from "../adapter/contract.js";
import { permissionMethods, sessionModeClamp } from "../permissions/methods.js";
import { permissionsProjector, readPermissionSettings } from "../permissions/permissions-store.js";
import { policySettings, resolvePolicy } from "../permissions/resolver.js";
import { runMethods } from "../runs/run-methods.js";
import { runsProjector } from "../runs/runs-projector.js";
import { createCompactionSweep } from "../sessions/compaction.js";
import { createDeletion } from "../sessions/deletion.js";
import { groupMethods } from "../sessions/group-methods.js";
import { sessionMethods } from "../sessions/methods.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { createTerminalService } from "../terminals/service.js";
import type { TerminalsOptions } from "../terminals/terminals.js";
import { workspaceMethods } from "../workspace/methods.js";
import { createSettleSweep } from "../sessions/settle-sweep.js";
import { settingsMethods } from "../settings/methods.js";
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
import { fileVault, VAULT_FILE, type Vault } from "./vault.js";

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

/** The database file in the data directory. */
export const DATABASE_FILE = "environment.db";

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

/** A startup step failed. Everything opened before it was closed, and `prepared` was never signalled. */
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
  /** Preset: the file vault in the data directory. */
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
  /** The sign-in director `accounts.add` hands a new account to. Preset: the one that says sign-in is not built yet, until #135. */
  readonly signIn?: SignInDirectorFactory;
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
    readonly broker?: PermissionBroker;
    /** Preset: the policy resolver on the environment's permission settings (#129). */
    readonly resolvePolicy?: PolicySeam;
  };
  /** How terminals start: the pty, the shell, the base environment. Preset: `node-pty`, the user's login shell, the clean base (`terminals/`). */
  readonly terminals?: Omit<TerminalsOptions, "clock">;
}

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
 * Starts an environment: refuses root before anything is created, then runs
 * the startup steps in order. Discovery and health are routed before the bind,
 * so they answer `starting` from the first byte; readiness is `ready` only
 * once `prepared` has been signalled. A failed step closes what was opened,
 * signals nothing, and rejects with a `StartupError` naming the step.
 */
export const startEnvironment = async (options: EnvironmentOptions = {}): Promise<EnvironmentHandle> => {
  refusePrivilegedUser(options.user ?? processUserCheck());

  const dataDir = options.dataDir ?? defaultDataDirectory();
  const clock: Clock = options.clock ?? systemClock;
  const now = () => clock.now();
  const launcher = options.launcher ?? processLauncherChannel();
  const capabilities: CapabilityFlags = [];
  // Set when the listeners are bound: local-only until then, which is what binding loopback alone means.
  let authPolicy: AuthPolicy = "local-only";
  // The name the Host check admits: set only once the tailnet address is bound.
  let tailnetName: string | undefined;

  let readiness: EnvironmentReadiness = "starting";
  let address: Address | undefined;
  const closers = createCloserStack();
  // Pushed first, so it closes last: after the listener and the event log, and after a failed start too.
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
    const opened = openEventLog({ path: join(dataDir, DATABASE_FILE), clock: now });
    closers.push(() => opened.close());
    return opened;
  });

  await step("projectors", () => {
    for (const projector of [sessionListProjector, runsProjector, settingsProjector, permissionsProjector, accountsProjector, ...(options.projectors ?? [])]) {
      log.registerProjector(projector);
    }
  });

  // Where pairing links point: set when the listeners are bound, before any request is served.
  let linkOrigin: string | undefined;
  // The permission settings (#129), read where they are used: inside a command, in its transaction.
  const permissionSettings = () => readPermissionSettings({ all: (sql, ...params) => log.read(sql, ...params) });

  // The record, the signing key and the auth tables: client sessions and pairings are read once, here, into memory.
  const { record, clientSessions, pairings, accessLog } = await step("identity", async () => {
    const name = (options.name ?? hostname()).trim();
    if (!name) throw new Error("An environment's name cannot be empty.");
    const loaded: EnvironmentRecord = loadOrCreateRecord(dataDir, name, now);
    const key = await ensureSigningKey(options.vault ?? fileVault(join(dataDir, VAULT_FILE)));
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
    return { record: loaded, clientSessions: loadedClientSessions, pairings: loadedPairings, accessLog: access };
  });

  // The account store and the adapter host: the adapters, the accounts' sign-in states read through their probes, the run registry.
  const { host, accounts } = await step("adapter-host", async () => {
    // First the recovery sweep: a run the log left without an end was cut by the last stop, and is ended before anything can read it.
    const recovered = recoverCutRuns({ log, clock });
    if (recovered.length > 0) console.error(`The recovery sweep ended ${recovered.length} run(s) a restart cut: ${recovered.join(", ")}.`);
    // Then the queued messages' attachment bytes, read back from the stage, so a message the sweep handed back keeps them (#185).
    const attachmentStage = createAttachmentStage(join(dataDir, ATTACHMENTS_DIRECTORY));
    const stagedAttachments = recoverStagedAttachments({ log, stage: attachmentStage });
    const adapters = options.adapters ?? [createClaudeAdapter({ clock, autoMemoryRoot: join(dataDir, AUTO_MEMORY_DIRECTORY) })];
    const settings = () => readSettings({ all: (sql, ...params) => log.read(sql, ...params) });
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
      ...(options.signIn !== undefined && { signIn: options.signIn }),
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
      resolvePolicy: ({ actor, requested, accountModes }) =>
        resolvePolicy({
          actor,
          requested,
          ceiling: actor.ceiling,
          accountModes,
          settings: policySettings(permissionSettings()),
        }),
      ceilingOf: (id) => clientSessions.ceiling(id),
      processIdleMinutes: options.processIdleMinutes ?? (() => settings()["providers.processIdleMinutes"]),
      ...options.adapterSeams,
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
      harnessVersion: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      authPolicy,
      readiness,
    };
    sendJson(response, 200, document, noStore);
  });
  surface.route("GET", HEALTH_PATH, (_request, response) => {
    const health: HealthDocument = { status: readiness, version: HARNESS_VERSION };
    sendJson(response, 200, health, noStore);
  });

  // The environment's own notices: environment.subscribe's stream, whose snapshot is the status.
  const environmentStream = { kind: ENVIRONMENT_STREAM_KIND, id: record.id };
  const detector = options.containerDetector ?? processContainerDetector();
  // The purge: `sessions.purge` runs it at once, the minute sweep for every session past its grace period.
  const deletion = createDeletion({ log, transcripts: host.transcripts });
  const lifecycle = createLifecycle({
    clock,
    runs: host.runs,
    log,
    stream: environmentStream,
    updatesManagedOutside: detector.inContainer() && !launcher.present(),
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
    close: () => close(),
  });
  // The terminals (#124): their output never enters the log; closed before the log is, and on a session's deletion.
  const terminalService = createTerminalService({ log, clock, ...options.terminals });
  closers.push(() => terminalService.close());
  // The shelf's sweep (#117): started once the environment is ready; a settings change runs it from the change's commit.
  const settleSweep = createSettleSweep({ log, clock });
  const table = createMethodTable({
    ...lifecycle.handlers,
    "environment.subscribe": () => lifecycle.source,
    // The rebuild joins the command's transaction, so it and the receipt commit together.
    "environment.rebuildProjections": () => ({
      aggregate: environmentStream,
      result: { projectors: [...log.rebuildProjections()], sequence: log.head() },
    }),
    // The generic settings (#117), on the environment's settings stream.
    ...settingsMethods({ log, environmentId: record.id, onChange: (keys) => settleSweep.settingsChanged(keys) }),
    ...accessMethods({ pairings, clientSessions, accessLog }),
    ...sessionMethods({
      log,
      clock: now,
      deletion,
      validateRunParameters: host.validateSessionInput,
      clampSessionMode: sessionModeClamp({ host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    }),
    ...groupMethods({ log, clock: now }),
    ...runMethods({ log, host, ceilingOf: (id) => clientSessions.ceiling(id) }),
    ...permissionMethods({ log, host, accessLog, clock, environmentId: record.id, ceilingOf: (id) => clientSessions.ceiling(id) }),
    ...processMethods({ log, host }),
    ...accountMethods({ accounts, host }),
    ...usageMethods({ pool: usagePool, accounts, clock }),
    ...terminalService.handlers,
    ...workspaceMethods({ log }),
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

  await step("prepared", () => launcher.prepared());
  readiness = "ready";
  // Only a start the launcher accepted is noted, and before the wire opens, so a first subscriber finds it.
  try {
    log.append(
      environmentStream,
      [{ type: "environment.started", payload: { harnessVersion: HARNESS_VERSION, protocolVersion: PROTOCOL_VERSION } }],
      { actor: formatActor({ kind: "system", id: "lifecycle" }) },
    );
  } catch (error) {
    await closers.closeAll().catch((closeError: unknown) => console.error("Closing after a failed start failed:", closeError));
    throw new StartupError("prepared", error);
  }
  // Deleted sessions whose grace period ran out while the environment was down go before any client can read them.
  try {
    deletion.purgeDue(clock.now());
  } catch (error) {
    console.error("The startup purge failed; the minute sweep will try again:", error);
  }
  // The shelf's sweep (#117): a pass now, before the wire opens, then every five minutes.
  closers.push(settleSweep.start());
  // Transcript compaction (#123): a pass now, before the wire opens, then once a day.
  closers.push(createCompactionSweep({ log, clock }).start());
  wire.open();
  launcher.onQuery((query) => lifecycle.answer(query));
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
    sockets: () => wire.sockets(),
    subscriptions: () => wire.subscriptions(),
    log,
    close,
  };
};
