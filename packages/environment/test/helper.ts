import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapGrant,
  ClientSessionCredential,
  PAIR_PATH,
  PROTOCOL_VERSION,
  type BootstrapKind,
  type Ceiling,
  type ClientKind,
  type ResultOf,
  type Scope,
  type Method,
  type MethodName,
  type Registry,
} from "@agent-harness/contracts";
import type { z } from "zod";
import type { Address } from "../src/serve/http.js";
import type { InterfaceDetector } from "../src/serve/interfaces.js";
import { startEnvironment, type EnvironmentHandle, type EnvironmentOptions, type StartupHooks } from "../src/serve/start.js";
import type { ContainerDetector } from "../src/serve/container.js";
import { createRunRegistry, type MemoryRunRegistry } from "../src/serve/run-registry.js";
import type { ContextOf, HandlerReturn, MethodHandler } from "../src/serve/methods.js";
import type { SubscriptionHooks } from "../src/wire/subscriptions.js";
import { manualClock, type ManualClock } from "./clock.js";
import type { ConfiguredAccount } from "../src/accounts/account-service.js";
import type { SignInDirectorFactory } from "../src/accounts/sign-in.js";
import { fakeAdapter, type FakeAdapter } from "./fake-adapter.js";
import { testLauncher, type TestLauncher } from "./launcher.js";
import {
  ByeError,
  WAIT_MS,
  connectClient,
  openSocket,
  type AuthOptions,
  type ClientSocket,
  type OpenOptions,
  type WireClient,
} from "./wire-client.js";

/**
 * The primary seam (env spec, "Testing Decisions"): an environment started
 * in-process on a temporary data directory, bound to loopback on port 0, with
 * the scripted fake adapter and a manual clock, driven by a real client over
 * a real WebSocket. Every behaviour of the wire is a test through it.
 */

export interface TestEnvironmentOptions {
  /** Preset: a manual clock at `MANUAL_CLOCK_START`. */
  readonly clock?: ManualClock;
  /** Preset: the scripted fake adapter with its preset script (`fake-adapter.ts`). */
  readonly adapter?: FakeAdapter;
  /**
   * The accounts carried over from configuration into the account store on
   * the first start (#119's path, kept for this). Preset: one, `claude-max`,
   * on the fake adapter's provider, in the fake's own directory; `[]` starts
   * with none, for a test that adopts or adds its own.
   */
  readonly accounts?: readonly ConfiguredAccount[];
  /** The sign-in director `accounts.add` hands an account to; preset: the environment's (sign-in not built yet). */
  readonly signIn?: SignInDirectorFactory;
  /** How long a status or model probe may take; preset: the environment's. */
  readonly probeTimeoutMs?: number;
  /** A data directory to start on, kept by `close`: a restart on the same directory. Preset: a fresh temporary one, removed by `close`. */
  readonly dataDir?: string;
  readonly name?: string;
  /** Startup hooks, to hold the startup gate. */
  readonly hooks?: StartupHooks;
  /** Preset: a machine with no Tailscale address and no tailnet name (`NO_INTERFACES`), so a test never binds a real interface. */
  readonly interfaces?: InterfaceDetector;
  readonly bindTailnet?: boolean;
  readonly bindLan?: boolean;
  readonly lanAddress?: string;
  readonly tailnetName?: string;
  /** Subscription seams: hold a catch-up, slow a socket down. */
  readonly subscriptionHooks?: SubscriptionHooks;
  /** Preset: whatever the machine is, reported as no container, so updates are not managed outside. */
  readonly containerDetector?: ContainerDetector;
  /** Preset: a test launcher that says no launcher is present. */
  readonly launcher?: TestLauncher;
  /** The adapter host's seams (the broker, the clamp, ...); preset: each seam's own. */
  readonly adapterSeams?: EnvironmentOptions["adapterSeams"];
  /** The idle time of a provider process, in minutes; preset: the setting's preset. */
  readonly processIdleMinutes?: () => number;
}

/** A machine with no Tailscale address and no tailnet name. */
export const NO_INTERFACES: InterfaceDetector = { tailscaleAddress: async () => undefined, tailnetName: async () => undefined };

/** What a pairing is minted with, and the client session its exchange asks for. */
export interface PairOptions {
  readonly scopes?: readonly Scope[];
  readonly ceiling?: Ceiling;
  /** Preset `program`. */
  readonly kind?: ClientKind;
  /** Preset `a paired <kind>`. */
  readonly label?: string;
}

export interface ClientOptions extends OpenOptions, Partial<Omit<AuthOptions, "token">> {
  /**
   * The token to authenticate with. Preset: the helper's default client
   * session, a `tui` bootstrap exchanged on first use and shared by every
   * client that names no token, so a test opening many clients stays under
   * the exchange's rate limit; it is exchanged again if it has been revoked
   * or has expired.
   */
  readonly token?: string;
}

/**
 * What a test method's handler returns: its result; for a command the
 * outcome naming its aggregate, at once; for a stream the source whose
 * snapshot the result is.
 */
export type TestAnswer<M extends Method> = HandlerReturn<M["kind"], z.infer<M["result"]>>;

/** A raw answer from the bootstrap exchange. */
export interface ExchangeAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface TestEnvironment {
  readonly env: EnvironmentHandle;
  readonly address: Address;
  readonly clock: ManualClock;
  readonly adapter: FakeAdapter;
  readonly dataDir: string;
  /** The run registry the environment's idle rule and drain read: the test starts, parks and ends runs on it. */
  readonly runs: MemoryRunRegistry;
  /** The launcher's channel: what the environment signalled, and its idle and drain queries. */
  readonly launcher: TestLauncher;
  /** The bootstrap grant file as it is now. */
  grant(): BootstrapGrant;
  /** Posts `body` to the bootstrap exchange as it is. */
  exchange(body: unknown): Promise<ExchangeAnswer>;
  /** Exchanges the current grant for a local client session of `kind`; throws unless the exchange succeeds. */
  bootstrap(kind?: BootstrapKind, label?: string): Promise<ClientSessionCredential>;
  /** Posts `body` to the pairing exchange as it is. */
  pairExchange(body: unknown): Promise<ExchangeAnswer>;
  /** Mints a pairing through the default client (`access.pairings.create`), on a socket closed after, and returns its result (the receipt aside). */
  createPairing(options?: Pick<PairOptions, "scopes" | "ceiling">): Promise<ResultOf<"access.pairings.create">>;
  /** Mints a pairing and exchanges it at `/api/pair`; throws unless both succeed. */
  pair(options?: PairOptions): Promise<ClientSessionCredential>;
  /** A client that has authenticated: with the token given, or the default client session's. Closed by `close`. */
  client(options?: ClientOptions): Promise<WireClient>;
  /** A WebSocket that has sent nothing yet. Closed by `close`. */
  open(options?: OpenOptions): Promise<ClientSocket>;
  /**
   * Serves a method the contracts registry does not hold, a suite's
   * synthetic stream or command, on the environment's method table as if it
   * were registered: its handler typed from the method's own schemas. A
   * command is answered with its receipt like any other.
   */
  serve<M extends Method>(
    method: M,
    handler: (params: z.infer<M["params"]>, context: ContextOf<M["kind"]>) => TestAnswer<M>,
  ): void;
  /** Closes every client, then the environment, then removes the data directory if the helper made it. */
  close(): Promise<void>;
}

/** Resolves once `condition` holds, polling in real time; rejects after `WAIT_MS`. */
const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out after ${WAIT_MS} ms waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

/** Posts `body` as JSON to the bootstrap exchange at `address`. */
export const postExchange = async (address: Address, body: unknown): Promise<ExchangeAnswer> => {
  const response = await fetch(`http://${address.host}:${address.port}${BOOTSTRAP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** Posts `body` as JSON to the pairing exchange at `address`. */
export const postPair = async (address: Address, body: unknown): Promise<ExchangeAnswer> => {
  const response = await fetch(`http://${address.host}:${address.port}${PAIR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** The grant file in `dataDir`, checked against its schema. */
export const readGrant = (dataDir: string): BootstrapGrant =>
  BootstrapGrant.parse(JSON.parse(readFileSync(join(dataDir, BOOTSTRAP_GRANT_FILE), "utf8")));

/** Exchanges the grant in `dataDir` at `address` for a local client session; throws unless it succeeds. */
export const bootstrapExchange = async (
  address: Address,
  dataDir: string,
  kind: BootstrapKind = "tui",
  label = `test ${kind}`,
): Promise<ClientSessionCredential> => {
  const answer = await postExchange(address, { secret: readGrant(dataDir).secret, kind, label });
  if (answer.status !== 200) throw new Error(`The bootstrap exchange answered ${answer.status}: ${JSON.stringify(answer.body)}`);
  return ClientSessionCredential.parse(answer.body);
};

/** Starts an environment for a test. The caller closes it, typically with its cleanup hook. */
export const startTestEnvironment = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const clock = options.clock ?? manualClock();
  const adapter = options.adapter ?? fakeAdapter();
  const accounts = options.accounts ?? [{ id: "claude-max", provider: adapter.descriptor.provider }];
  const ownDir = options.dataDir === undefined ? mkdtempSync(join(tmpdir(), "agent-harness-env-")) : undefined;
  const dataDir = options.dataDir ?? join(ownDir as string, "data");
  const runs = createRunRegistry({ clock });
  const launcher = options.launcher ?? testLauncher();

  const passed: Partial<EnvironmentOptions> = {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.hooks !== undefined && { hooks: options.hooks }),
    ...(options.bindTailnet !== undefined && { bindTailnet: options.bindTailnet }),
    ...(options.bindLan !== undefined && { bindLan: options.bindLan }),
    ...(options.lanAddress !== undefined && { lanAddress: options.lanAddress }),
    ...(options.tailnetName !== undefined && { tailnetName: options.tailnetName }),
    ...(options.adapterSeams !== undefined && { adapterSeams: options.adapterSeams }),
    ...(options.processIdleMinutes !== undefined && { processIdleMinutes: options.processIdleMinutes }),
    ...(options.signIn !== undefined && { signIn: options.signIn }),
    ...(options.probeTimeoutMs !== undefined && { probeTimeoutMs: options.probeTimeoutMs }),
  };
  let env: EnvironmentHandle;
  try {
    env = await startEnvironment({
      dataDir,
      port: 0,
      clock,
      // The agent box and CI may run as root; the refusal has its own tests.
      user: { isPrivileged: () => false },
      launcher,
      runs,
      containerDetector: options.containerDetector ?? { inContainer: () => false },
      interfaces: options.interfaces ?? NO_INTERFACES,
      adapters: [adapter],
      accounts,
      ...passed,
      ...(options.subscriptionHooks !== undefined && { subscriptionHooks: options.subscriptionHooks }),
    });
  } catch (error) {
    if (ownDir) rmSync(ownDir, { recursive: true, force: true });
    throw error;
  }

  /** The entries `serve` was given, which every client's `apply` consults before the registry. */
  const served = new Map<string, Method>();
  const servedMethod = (name: string): Method | undefined => served.get(name);

  const sockets = new Set<ClientSocket>();
  /**
   * Tracks a socket for `close`, and makes its own `close` wait until the
   * environment has seen it go, so a test that moves the clock next moves it
   * after the socket closed, never before.
   */
  const track = <C extends ClientSocket>(socket: C): C => {
    const tracked: C = {
      ...socket,
      close: async () => {
        const before = env.sockets();
        const wasOpen = socket.isOpen();
        await socket.close();
        if (wasOpen) await until(() => env.sockets() < before, "the environment to see the socket close");
      },
    };
    sockets.add(tracked);
    return tracked;
  };

  let defaultToken: string | undefined;
  const defaultClient = async (options: ClientOptions): Promise<WireClient> => {
    defaultToken ??= (await bootstrapExchange(env.address, dataDir, "tui", "the helper's default client")).token;
    try {
      return await connectClient(env.address, { methods: servedMethod, ...options, token: defaultToken });
    } catch (error) {
      const reason = error instanceof ByeError ? error.bye?.reason : undefined;
      if (reason !== "revoked" && reason !== "expired") throw error;
      defaultToken = (await bootstrapExchange(env.address, dataDir, "tui", "the helper's default client")).token;
      return connectClient(env.address, { methods: servedMethod, ...options, token: defaultToken });
    }
  };

  /** Mints a pairing over a socket of the default client session, opened for the request and closed after, so no socket stays open for time to be advanced over. */
  const createPairing = async (pairOptions: Pick<PairOptions, "scopes" | "ceiling"> = {}) => {
    const admin = track(await defaultClient({}));
    try {
      return await admin.apply("access.pairings.create", {
        commandId: randomUUID(),
        ...(pairOptions.scopes !== undefined && { scopes: [...pairOptions.scopes] }),
        ...(pairOptions.ceiling !== undefined && { ceiling: pairOptions.ceiling }),
      });
    } finally {
      await admin.close();
    }
  };

  return {
    env,
    address: env.address,
    clock,
    adapter,
    dataDir,
    runs,
    launcher,
    grant: () => readGrant(dataDir),
    exchange: (body) => postExchange(env.address, body),
    bootstrap: (kind, label) => bootstrapExchange(env.address, dataDir, kind, label),
    pairExchange: (body) => postPair(env.address, body),
    createPairing,
    async pair(pairOptions = {}) {
      const { code } = await createPairing(pairOptions);
      const kind = pairOptions.kind ?? "program";
      const answer = await postPair(env.address, {
        code,
        kind,
        label: pairOptions.label ?? `a paired ${kind}`,
        protocolVersion: PROTOCOL_VERSION,
      });
      if (answer.status !== 200) throw new Error(`The pairing exchange answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      return ClientSessionCredential.parse(answer.body);
    },
    async client(clientOptions = {}) {
      const { token } = clientOptions;
      return track(token === undefined ? await defaultClient(clientOptions) : await connectClient(env.address, { methods: servedMethod, ...clientOptions, token }));
    },
    open: async (openOptions) => track(await openSocket(env.address, openOptions)),
    serve(method, handler) {
      served.set(method.name, method);
      // The one cast: a method no registry holds is handed to the table as the registered method it stands in for.
      env.methods.register(method as unknown as Registry[MethodName], handler as unknown as MethodHandler<MethodName>);
    },
    async close() {
      await Promise.allSettled([...sockets].map((socket) => socket.close()));
      sockets.clear();
      try {
        await env.close();
      } finally {
        if (ownDir) rmSync(ownDir, { recursive: true, force: true });
      }
    },
  };
};
