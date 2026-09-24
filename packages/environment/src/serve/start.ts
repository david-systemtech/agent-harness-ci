import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_PATH,
  DISCOVERY_PATH,
  ENVIRONMENT_STREAM_KIND,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  WIRE_PATH,
  type AuthPolicy,
  type CapabilityFlags,
  type DiscoveryDocument,
  type EnvironmentReadiness,
  type HealthDocument,
} from "@agent-harness/contracts";
import { createBootstrapGrant } from "../auth/bootstrap.js";
import { SWEEP_INTERVAL_MS, createClientSessions, type ClientSessionIssuer, type ClientSessions } from "../auth/client-sessions.js";
import { createRateLimiter } from "../auth/rate-limit.js";
import { formatActor, openEventLog, type EventLog, type Projector } from "../event-log/event-log.js";
import type { SubscriptionHooks } from "../wire/subscriptions.js";
import { createWire } from "../wire/wire.js";
import { systemClock, type Clock } from "./clock.js";
import { createCloserStack } from "./closers.js";
import { defaultDataDirectory, prepareDataDirectory } from "./data-directory.js";
import { createHttpSurface, sendJson, type Address, type HttpRoutes } from "./http.js";
import { ensureSigningKey, loadOrCreateRecord, type EnvironmentRecord } from "./identity.js";
import { processLauncherChannel, type LauncherChannel } from "./launcher.js";
import { createMethodTable, type MethodHandlers, type MethodTable } from "./methods.js";
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

/** The loopback address the environment binds. The tailnet interface is #109's. */
const LOOPBACK = "127.0.0.1";

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
  /** The environment's own tailnet name, which the Host check accepts beside loopback. */
  readonly tailnetName?: string;
  /** Preset: the running process's user (`processUserCheck`). */
  readonly user?: UserCheck;
  /** Preset: the IPC channel of a launcher that spawned the environment, else nothing (`processLauncherChannel`). */
  readonly launcher?: LauncherChannel;
  /** Preset: the file vault in the data directory. */
  readonly vault?: Vault;
  /** Registered and caught up from their cursors in the `projectors` step. None exist yet. */
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
}

/** A running environment. */
export interface EnvironmentHandle {
  readonly id: string;
  readonly name: string;
  readonly dataDir: string;
  /** Where the loopback listener is bound. */
  readonly address: Address;
  readiness(): EnvironmentReadiness;
  /**
   * The methods the wire dispatches into after its scope check: every
   * registry method, with its handler once one is registered. A feature that
   * starts after the environment registers its handlers here.
   */
  readonly methods: MethodTable;
  /** The listener's route table, behind the Host check. */
  readonly http: HttpRoutes;
  /** Issuing and revoking client sessions: the seam pairing and the access methods (#109) build on. */
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
  // Only loopback is bound until the tailnet binding (#109).
  const authPolicy: AuthPolicy = "local-only";

  let readiness: EnvironmentReadiness = "starting";
  let address: Address | undefined;
  const closers = createCloserStack();
  // Pushed first, so it closes last: after the listener and the event log, and after a failed start too.
  closers.push(() => launcher.close());

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
    for (const projector of options.projectors ?? []) log.registerProjector(projector);
  });

  // The record, the signing key and the auth tables: client sessions are read once, here, into memory.
  const { record, clientSessions } = await step("identity", async () => {
    const name = (options.name ?? hostname()).trim();
    if (!name) throw new Error("An environment's name cannot be empty.");
    const loaded: EnvironmentRecord = loadOrCreateRecord(dataDir, name, now);
    const key = await ensureSigningKey(options.vault ?? fileVault(join(dataDir, VAULT_FILE)));
    const loadedClientSessions: ClientSessions = createClientSessions({ table: log.clientSessions, key, environmentId: loaded.id, clock });
    return { record: loaded, clientSessions: loadedClientSessions };
  });

  // The adapter host (#119) starts here; there is none yet.
  await step("adapter-host", () => undefined);

  const surface = createHttpSurface({ tailnetName: options.tailnetName });
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
  const methods: MethodHandlers = {
    "environment.status": () => ({ readiness }),
    "environment.subscribe": () => ({ stream: environmentStream, snapshot: () => ({ status: { readiness } }) }),
  };
  const table = createMethodTable(methods);

  // The grant file and the wire are routed before the bind; both refuse work until the gate below.
  const grant = createBootstrapGrant({
    dataDir,
    clientSessions,
    rateLimiter: createRateLimiter({ clock }),
    readiness: () => readiness,
  });
  surface.route("POST", BOOTSTRAP_PATH, grant.exchange);
  const wire = createWire({
    environment: record,
    capabilities,
    clientSessions,
    methods: table,
    clock,
    log,
    ...(options.subscriptionHooks !== undefined && { subscriptionHooks: options.subscriptionHooks }),
  });
  surface.upgrade(WIRE_PATH, wire.upgrade);

  const bound = await step("listen", async () => {
    closers.push(() => surface.close());
    const listening = await surface.listen(LOOPBACK, options.port ?? DEFAULT_PORT);
    address = listening;
    // Closed before the listener, so no socket holds its close open.
    closers.push(() => wire.close());
    closers.push(() => grant.remove());
    grant.issue(listening);
    return listening;
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
  wire.open();
  const sweep = clock.setInterval(() => clientSessions.sweep(), SWEEP_INTERVAL_MS);
  closers.push(() => sweep.cancel());

  // Concurrent closes share one attempt; a close after a failed one retries what did not close.
  let closing: Promise<void> | undefined;
  return {
    id: record.id,
    name: record.name,
    dataDir,
    address: bound,
    readiness: () => readiness,
    methods: table,
    http: { route: (method, path, handler) => surface.route(method, path, handler) },
    clientSessions: { issue: (request) => clientSessions.issue(request), revoke: (id) => clientSessions.revoke(id) },
    sockets: () => wire.sockets(),
    subscriptions: () => wire.subscriptions(),
    log,
    close: () => (closing ??= closers.closeAll().finally(() => (closing = undefined))),
  };
};
