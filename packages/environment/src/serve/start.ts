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
import { sessionMethods } from "../sessions/methods.js";
import { sessionListProjector } from "../sessions/session-list.js";
import { createSettleSweep } from "../sessions/settle-sweep.js";
import { settingsMethods } from "../settings/methods.js";
import { settingsProjector } from "../settings/settings-store.js";
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
import { createRunRegistry, type RunRegistry } from "./run-registry.js";
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
  /** The runs the idle rule and the drain read, and the drain's admission gate. Preset: an empty in-memory registry, until the adapter host (#119). */
  readonly runs?: RunRegistry;
  /** Whether this is a container; with no launcher present too, updates are managed outside. Preset: `processContainerDetector`. */
  readonly containerDetector?: ContainerDetector;
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
    for (const projector of [sessionListProjector, settingsProjector, ...(options.projectors ?? [])]) log.registerProjector(projector);
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

  // The adapter host (#119) starts here; there is none yet.
  await step("adapter-host", () => undefined);

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
  const lifecycle = createLifecycle({
    clock,
    runs: options.runs ?? createRunRegistry({ clock }),
    log,
    stream: environmentStream,
    updatesManagedOutside: detector.inContainer() && !launcher.present(),
    readiness: () => readiness,
    onDraining: () => void (readiness = "draining"),
    close: () => close(),
  });
  const table = createMethodTable({
    ...lifecycle.handlers,
    "environment.subscribe": () => lifecycle.source,
    // The rebuild joins the command's transaction, so it and the receipt commit together.
    "environment.rebuildProjections": () => ({
      aggregate: environmentStream,
      result: { projectors: [...log.rebuildProjections()], sequence: log.head() },
    }),
    // The generic settings (#117), on the environment's settings stream.
    ...settingsMethods({ log, environmentId: record.id }),
    ...accessMethods({ pairings, clientSessions, accessLog }),
    ...sessionMethods({ log, clock: now }),
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
  // The shelf's sweep (#117): a pass now, before the wire opens, then every five minutes and on an auto-settle setting's change.
  closers.push(createSettleSweep({ log, clock }).start());
  wire.open();
  launcher.onQuery((query) => lifecycle.answer(query));
  // The minute sweep: expired pairings, idle `tui` local client sessions, and receipts past their 30 days.
  const sweep = clock.setInterval(() => {
    try {
      accessLog.atomically((tx) => {
        clientSessions.sweep(tx);
        pairings.sweep(tx);
      });
      log.pruneReceipts(clock.now());
    } catch (error) {
      console.error("The sweep failed:", error);
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
