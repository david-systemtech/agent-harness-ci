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
import { createAdapterHost, type AdapterHost, type HostAccount } from "../adapter/host.js";
import type { InstructionComposer, ModeClamp, ToolServerFactory } from "../adapter/seams.js";
import type { PermissionBroker } from "../adapter/contract.js";
import { runMethods } from "../runs/run-methods.js";
import { runsProjector } from "../runs/runs-projector.js";
import { createDeletion } from "../sessions/deletion.js";
import { groupMethods } from "../sessions/group-methods.js";
import { sessionMethods } from "../sessions/methods.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { createTerminalService } from "../terminals/service.js";
import type { TerminalsOptions } from "../terminals/terminals.js";
import { workspaceMethods } from "../workspace/methods.js";
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
  /** The adapters the adapter host holds, one per provider. Preset: none, until the Claude adapter (#121). */
  readonly adapters?: readonly Adapter[];
  /** The accounts runs go through. Preset: none, until the account store (#134) supplies them. */
  readonly accounts?: readonly HostAccount[];
  /** The account a session with none of its own runs on. Preset: the first account. */
  readonly defaultAccountId?: string;
  /** The adapter host's seams other workstreams fill; each has a preset (`adapter/seams.ts`). */
  readonly adapterSeams?: {
    readonly toolServers?: ToolServerFactory;
    readonly instructions?: InstructionComposer;
    readonly broker?: PermissionBroker;
    readonly clampMode?: ModeClamp;
  };
  /** How terminals start: the pty, the shell, the base environment. Preset: `node-pty`, the user's login shell, the clean base (`terminals/`). */
  readonly terminals?: Omit<TerminalsOptions, "now">;
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
    for (const projector of [sessionListProjector, runsProjector, ...(options.projectors ?? [])]) log.registerProjector(projector);
  });

  // Where pairing links point: set when the listeners are bound, before any request is served.
  let linkOrigin: string | undefined;

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
    });
    return { record: loaded, clientSessions: loadedClientSessions, pairings: loadedPairings, accessLog: access };
  });

  // The adapter host: the adapters, the accounts' sign-in states read through their probes, the run registry.
  const host: AdapterHost = await step("adapter-host", async () => {
    const created = createAdapterHost({
      log,
      clock,
      ...(options.runs !== undefined && { runs: options.runs }),
      ...(options.adapters !== undefined && { adapters: options.adapters }),
      ...(options.accounts !== undefined && { accounts: options.accounts }),
      ...(options.defaultAccountId !== undefined && { defaultAccountId: options.defaultAccountId }),
      ...options.adapterSeams,
    });
    // Closed before the event log, so a run the close ends has its end appended: drained when a drain's cap cut it.
    closers.push(() => created.close(readiness === "draining" ? "drained" : "disposed"));
    await created.refresh();
    return created;
  });

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
    onDraining: () => void (readiness = "draining"),
    close: () => close(),
  });
  // The terminals (#124): their output never enters the log; closed before the log is, and on a session's deletion.
  const terminalService = createTerminalService({ log, now, ...options.terminals });
  closers.push(() => terminalService.close());
  const table = createMethodTable({
    ...lifecycle.handlers,
    "environment.subscribe": () => lifecycle.source,
    // The rebuild joins the command's transaction, so it and the receipt commit together.
    "environment.rebuildProjections": () => ({
      aggregate: environmentStream,
      result: { projectors: [...log.rebuildProjections()], sequence: log.head() },
    }),
    ...accessMethods({ pairings, clientSessions, accessLog }),
    ...sessionMethods({ log, clock: now, deletion, validateRunParameters: host.validateSessionInput }),
    ...groupMethods({ log, clock: now }),
    ...runMethods({ log, host }),
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
