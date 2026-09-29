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
import { createScrubRegistry, type ScrubRegistry } from "../src/scrub/registry.js";
import { managedGh } from "../src/forge/gh.js";
import { manualClock, type ManualClock } from "./clock.js";
import type { ContainmentProbe } from "../src/permissions/containment-probe.js";
import { absentProbe } from "./containment.js";
import type { ConfiguredAccount } from "../src/accounts/account-service.js";
import type { SignInDirectorFactory } from "../src/accounts/signin-seam.js";
import { fakeAdapter, type FakeAdapter } from "./fake-adapter.js";
import { refusingSpawn } from "./signin.js";
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
  /** The sign-in director `accounts.add` hands an account to; preset: the environment's (#135), run as `signInProcess` says. */
  readonly signIn?: SignInDirectorFactory;
  /**
   * How the environment's director runs sign-ins, each part over the
   * helper's preset: a spawn that refuses (so no test ever starts a real
   * binary; `fakeSignInSpawner` scripts one), `TEST_BUNDLED_CLAUDE` as the
   * bundled binary, no managed tool, and a host environment of a PATH alone.
   */
  readonly signInProcess?: EnvironmentOptions["signInProcess"];
  /** How long a status or model probe may take; preset: the environment's. */
  readonly probeTimeoutMs?: number;
  /** How long a plan-usage read may take; preset: the environment's. */
  readonly usageReadTimeoutMs?: number;
  /** A data directory to start on, kept by `close`: a restart on the same directory. Preset: a fresh temporary one, removed by `close`. */
  readonly dataDir?: string;
  /** The harness version the environment runs as; preset: the package's. */
  readonly harnessVersion?: string;
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
  /** Preset: a scripted launcher channel with no launcher present, as under a foreground `serve`. */
  readonly launcher?: TestLauncher;
  /** The adapter host's seams (the broker's automatic answers, the policy resolver, ...); preset: each seam's own. */
  readonly adapterSeams?: EnvironmentOptions["adapterSeams"];
  /** The idle time of a provider process, in minutes; preset: the setting's preset. */
  readonly processIdleMinutes?: () => number;
  /** How terminals start; preset the environment's own (`node-pty`, the login shell, the clean base). */
  readonly terminals?: EnvironmentOptions["terminals"];
  /**
   * What the containment probe finds (`test/containment.ts` scripts the
   * outcomes). Preset: bubblewrap missing, so only `off` is offered and the
   * real machine is never probed.
   */
  readonly containment?: ContainmentProbe | Promise<ContainmentProbe>;
  /** The resolver a new session's workspace goes through (`test/workspaces.ts` scripts one); preset: the environment's. */
  readonly workspaceResolver?: EnvironmentOptions["workspaceResolver"];
  /** What the environment's resolver reads beyond its data directory: roots declared, the home, the readable check, git's time. */
  readonly workspaces?: EnvironmentOptions["workspaces"];
  /** The scrub registry the environment holds; preset: a fresh one. */
  readonly scrub?: ScrubRegistry;
  /** How the ForgeService reaches a forge (`test/fake-forge.ts` routes github.com's API to a fake one); preset: the environment's. */
  readonly forgeFetch?: EnvironmentOptions["forgeFetch"];
  /** How long a forge call and a forge account's verification may take; preset: the environment's ten seconds. */
  readonly forgeTimeoutMs?: EnvironmentOptions["forgeTimeoutMs"];
  /** The environment's own `gh` (`test/fake-gh.ts` puts a fake one on a PATH); preset: a PATH with no `gh`, so a test never runs a real one. */
  readonly gh?: EnvironmentOptions["gh"];
  /** The key-manager registry's resolve seam (`test/key-managers.ts` scripts one); preset: the environment's, with no connection. */
  readonly keyManagers?: EnvironmentOptions["keyManagers"];
  /** How long a key-manager connection's verification, or a certificate preview, may take; preset: the environment's ten seconds. */
  readonly keyManagerTimeoutMs?: EnvironmentOptions["keyManagerTimeoutMs"];
  /** The vault the environment holds; preset: the file vault in the data directory. */
  readonly vault?: EnvironmentOptions["vault"];
  /** The command git names as its credential helper, before `git-credential <slug>`; preset none. */
  readonly harnessCommand?: EnvironmentOptions["harnessCommand"];
  /** Reads the bundled Claude Code's version; preset: `TEST_CLAUDE_CODE_VERSION`, so no test runs the real binary. */
  readonly claudeCodeVersion?: EnvironmentOptions["claudeCodeVersion"];
  /**
   * Where the release channel is read (`test/release-source.ts` makes a fake
   * one); preset `NO_RELEASE_SOURCE`, which refuses every connection, so no
   * test reads the project's own releases.
   */
  readonly releaseSource?: EnvironmentOptions["releaseSource"];
  /** The launcher protocol the environment's own launcher speaks, which a handover brings; preset the build's. */
  readonly launcherProtocol?: EnvironmentOptions["launcherProtocol"];
}

/** The release source a test environment reads unless told otherwise: a loopback port nothing listens on, so a check fails at once, unreachable. */
export const NO_RELEASE_SOURCE = { origin: "http://127.0.0.1:1", kind: "forgejo", repository: "david/agent-harness" } as const;

/** A PATH with nothing on it: where a test environment looks for `gh` unless the test gives it one. */
export const EMPTY_PATH = "/nonexistent/agent-harness-test-path";

/** The bundled binary a test environment's sign-ins name unless told otherwise: a path that is not there. */
export const TEST_BUNDLED_CLAUDE = "/nonexistent/agent-harness-sdk/claude";

/** The bundled Claude Code's version a test environment reads unless told otherwise. */
export const TEST_CLAUDE_CODE_VERSION = "2.1.0-test";

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
  /** The scripted launcher channel: what the environment signalled and sent, its answers, and the launcher's queries. */
  readonly launcher: TestLauncher;
  /** The environment's scrub registry: the test registers values on it as a service beside the environment would. */
  readonly scrub: ScrubRegistry;
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
  const scrub = options.scrub ?? createScrubRegistry();

  const passed: Partial<EnvironmentOptions> = {
    ...(options.name !== undefined && { name: options.name }),
    ...(options.harnessVersion !== undefined && { harnessVersion: options.harnessVersion }),
    ...(options.hooks !== undefined && { hooks: options.hooks }),
    ...(options.bindTailnet !== undefined && { bindTailnet: options.bindTailnet }),
    ...(options.bindLan !== undefined && { bindLan: options.bindLan }),
    ...(options.lanAddress !== undefined && { lanAddress: options.lanAddress }),
    ...(options.tailnetName !== undefined && { tailnetName: options.tailnetName }),
    ...(options.adapterSeams !== undefined && { adapterSeams: options.adapterSeams }),
    ...(options.processIdleMinutes !== undefined && { processIdleMinutes: options.processIdleMinutes }),
    ...(options.signIn !== undefined && { signIn: options.signIn }),
    ...(options.probeTimeoutMs !== undefined && { probeTimeoutMs: options.probeTimeoutMs }),
    ...(options.usageReadTimeoutMs !== undefined && { usageReadTimeoutMs: options.usageReadTimeoutMs }),
    ...(options.terminals !== undefined && { terminals: options.terminals }),
    ...(options.workspaceResolver !== undefined && { workspaceResolver: options.workspaceResolver }),
    ...(options.workspaces !== undefined && { workspaces: options.workspaces }),
    ...(options.forgeFetch !== undefined && { forgeFetch: options.forgeFetch }),
    ...(options.forgeTimeoutMs !== undefined && { forgeTimeoutMs: options.forgeTimeoutMs }),
    gh: options.gh ?? managedGh({ hostEnv: { PATH: EMPTY_PATH } }),
    ...(options.keyManagers !== undefined && { keyManagers: options.keyManagers }),
    ...(options.keyManagerTimeoutMs !== undefined && { keyManagerTimeoutMs: options.keyManagerTimeoutMs }),
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.harnessCommand !== undefined && { harnessCommand: options.harnessCommand }),
    claudeCodeVersion: options.claudeCodeVersion ?? (async () => TEST_CLAUDE_CODE_VERSION),
    releaseSource: options.releaseSource ?? NO_RELEASE_SOURCE,
    ...(options.launcherProtocol !== undefined && { launcherProtocol: options.launcherProtocol }),
    signInProcess: { spawn: refusingSpawn, bundled: TEST_BUNDLED_CLAUDE, managedTool: () => null, hostEnv: { PATH: "/usr/bin" }, ...options.signInProcess },
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
      scrub,
      containerDetector: options.containerDetector ?? { inContainer: () => false },
      interfaces: options.interfaces ?? NO_INTERFACES,
      adapters: [adapter],
      accounts,
      probeContainment: async () => (await options.containment) ?? absentProbe(),
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
    scrub,
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
