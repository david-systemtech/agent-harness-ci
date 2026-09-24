import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOTSTRAP_GRANT_FILE,
  BOOTSTRAP_PATH,
  BootstrapGrant,
  ClientSessionCredential,
  type BootstrapKind,
  type Method,
  type MethodName,
  type Registry,
} from "@agent-harness/contracts";
import type { z } from "zod";
import type { Address } from "../src/serve/http.js";
import type { HandlerResult, MethodContext, MethodHandler } from "../src/serve/methods.js";
import { startEnvironment, type EnvironmentHandle, type StartupHooks } from "../src/serve/start.js";
import type { SubscriptionHooks } from "../src/wire/subscriptions.js";
import { manualClock, type ManualClock } from "./clock.js";
import { fakeProvider, type FakeProvider } from "./fake-provider.js";
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
 * a scripted fake provider and a manual clock, driven by a real client over a
 * real WebSocket. Every behaviour of the wire is a test through it.
 */

export interface TestEnvironmentOptions {
  /** Preset: a manual clock at `MANUAL_CLOCK_START`. */
  readonly clock?: ManualClock;
  /** Preset: a fake provider with an empty script. #119 replaces it with the adapter contract's fake. */
  readonly provider?: FakeProvider;
  /** A data directory to start on, kept by `close`: a restart on the same directory. Preset: a fresh temporary one, removed by `close`. */
  readonly dataDir?: string;
  readonly name?: string;
  /** Startup hooks, to hold the startup gate. */
  readonly hooks?: StartupHooks;
  /** Subscription seams: hold a catch-up, slow a socket down. */
  readonly subscriptionHooks?: SubscriptionHooks;
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

/** What a test method's handler returns: its result, or for a stream the source whose snapshot the result is. */
export type TestAnswer<M extends Method> = HandlerResult<M["kind"], z.infer<M["result"]>>;

/** A raw answer from the bootstrap exchange. */
export interface ExchangeAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export interface TestEnvironment {
  readonly env: EnvironmentHandle;
  readonly address: Address;
  readonly clock: ManualClock;
  readonly provider: FakeProvider;
  readonly dataDir: string;
  /** The bootstrap grant file as it is now. */
  grant(): BootstrapGrant;
  /** Posts `body` to the bootstrap exchange as it is. */
  exchange(body: unknown): Promise<ExchangeAnswer>;
  /** Exchanges the current grant for a local client session of `kind`; throws unless the exchange succeeds. */
  bootstrap(kind?: BootstrapKind, label?: string): Promise<ClientSessionCredential>;
  /** A client that has authenticated: with the token given, or the default client session's. Closed by `close`. */
  client(options?: ClientOptions): Promise<WireClient>;
  /** A WebSocket that has sent nothing yet. Closed by `close`. */
  open(options?: OpenOptions): Promise<ClientSocket>;
  /**
   * Serves a method the contracts registry does not hold, a suite's
   * synthetic stream, on the environment's method table as if it were
   * registered: its handler typed from the method's own schemas.
   */
  serve<M extends Method>(
    method: M,
    handler: (params: z.infer<M["params"]>, context: MethodContext) => TestAnswer<M> | Promise<TestAnswer<M>>,
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
  const provider = options.provider ?? fakeProvider();
  const ownDir = options.dataDir === undefined ? mkdtempSync(join(tmpdir(), "agent-harness-env-")) : undefined;
  const dataDir = options.dataDir ?? join(ownDir as string, "data");

  let env: EnvironmentHandle;
  try {
    env = await startEnvironment({
      dataDir,
      port: 0,
      clock,
      // The agent box and CI may run as root; the refusal has its own tests.
      user: { isPrivileged: () => false },
      launcher: { prepared: () => undefined, close: () => undefined },
      ...(options.name !== undefined && { name: options.name }),
      ...(options.hooks !== undefined && { hooks: options.hooks }),
      ...(options.subscriptionHooks !== undefined && { subscriptionHooks: options.subscriptionHooks }),
    });
  } catch (error) {
    if (ownDir) rmSync(ownDir, { recursive: true, force: true });
    throw error;
  }

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
      return await connectClient(env.address, { ...options, token: defaultToken });
    } catch (error) {
      const reason = error instanceof ByeError ? error.bye?.reason : undefined;
      if (reason !== "revoked" && reason !== "expired") throw error;
      defaultToken = (await bootstrapExchange(env.address, dataDir, "tui", "the helper's default client")).token;
      return connectClient(env.address, { ...options, token: defaultToken });
    }
  };

  return {
    env,
    address: env.address,
    clock,
    provider,
    dataDir,
    grant: () => readGrant(dataDir),
    exchange: (body) => postExchange(env.address, body),
    bootstrap: (kind, label) => bootstrapExchange(env.address, dataDir, kind, label),
    async client(clientOptions = {}) {
      const { token } = clientOptions;
      return track(token === undefined ? await defaultClient(clientOptions) : await connectClient(env.address, { ...clientOptions, token }));
    },
    open: async (openOptions) => track(await openSocket(env.address, openOptions)),
    serve(method, handler) {
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
