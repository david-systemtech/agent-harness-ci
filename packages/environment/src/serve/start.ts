import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  DISCOVERY_PATH,
  HEALTH_PATH,
  PROTOCOL_VERSION,
  type AuthPolicy,
  type CapabilityFlags,
  type DiscoveryDocument,
  type EnvironmentReadiness,
  type HealthDocument,
} from "@agent-harness/contracts";
import { openEventLog, type EventLog, type Projector } from "../event-log/event-log.js";
import { createCloserStack } from "./closers.js";
import { defaultDataDirectory, prepareDataDirectory } from "./data-directory.js";
import { createHttpSurface, sendJson, type Address, type HttpRoutes } from "./http.js";
import { ensureSigningKey, loadOrCreateRecord, type EnvironmentRecord } from "./identity.js";
import { processLauncherChannel, type LauncherChannel } from "./launcher.js";
import type { MethodHandlers } from "./methods.js";
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
  readonly clock?: () => Date;
  readonly hooks?: StartupHooks;
}

/** A running environment. */
export interface EnvironmentHandle {
  readonly id: string;
  readonly name: string;
  readonly dataDir: string;
  /** Where the loopback listener is bound. */
  readonly address: Address;
  readiness(): EnvironmentReadiness;
  /** The handlers the wire (#108) dispatches into, by method name. */
  readonly methods: MethodHandlers;
  /** The listener's route table, behind the Host check. */
  readonly http: HttpRoutes;
  /**
   * Stops listening and closes the event log, each even when the other fails.
   * Idempotent; after a failure, calling it again retries what did not close.
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
  const clock = options.clock ?? (() => new Date());
  const launcher = options.launcher ?? processLauncherChannel();
  const capabilities: CapabilityFlags = [];
  // Only loopback is bound until the tailnet binding (#109).
  const authPolicy: AuthPolicy = "local-only";

  let readiness: EnvironmentReadiness = "starting";
  let address: Address | undefined;
  const closers = createCloserStack();

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
    const opened = openEventLog({ path: join(dataDir, DATABASE_FILE), clock });
    closers.push(() => opened.close());
    return opened;
  });

  await step("projectors", () => {
    for (const projector of options.projectors ?? []) log.registerProjector(projector);
  });

  // The auth tables are loaded here too once they exist (#108).
  const record: EnvironmentRecord = await step("identity", async () => {
    const name = (options.name ?? hostname()).trim();
    if (!name) throw new Error("An environment's name cannot be empty.");
    const loaded = loadOrCreateRecord(dataDir, name, clock);
    await ensureSigningKey(options.vault ?? fileVault(join(dataDir, VAULT_FILE)));
    return loaded;
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

  const bound = await step("listen", async () => {
    closers.push(() => surface.close());
    address = await surface.listen(LOOPBACK, options.port ?? DEFAULT_PORT);
    return address;
  });

  await step("prepared", () => launcher.prepared());
  readiness = "ready";

  const methods: MethodHandlers = {
    "environment.status": () => ({ readiness }),
  };

  // Concurrent closes share one attempt; a close after a failed one retries what did not close.
  let closing: Promise<void> | undefined;
  return {
    id: record.id,
    name: record.name,
    dataDir,
    address: bound,
    readiness: () => readiness,
    methods,
    http: { route: (method, path, handler) => surface.route(method, path, handler) },
    close: () => (closing ??= closers.closeAll().finally(() => (closing = undefined))),
  };
};
