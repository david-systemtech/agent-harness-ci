import type { BootstrapGrant, CredentialAccessRecord } from "@agent-harness/contracts";
import type { Observable } from "./observable.js";
import type { SecretProtection, Shell } from "./shell.js";

/**
 * What the runtime cannot own and every client supplies
 * (docs/specs/client-runtime.md, "Package and platform"): storage, secrets,
 * the network, time, and who the client is. The GUI and the terminal UI each
 * deliver one; tests use the in-memory platform in `testing/`.
 */
export interface Platform {
  /** Key-value document storage for client-local state: IndexedDB in the GUI, a state directory in the terminal UI. */
  readonly documents: DocumentStore;
  /** Where client session tokens live, and nowhere else: the OS keychain through the shell, or a 0600 file. */
  readonly secrets: SecretStore;
  /** Opens a WebSocket. */
  readonly webSocket: WebSocketFactory;
  /**
   * Plain HTTP, for the discovery document and the two exchanges. Not in the
   * specification's list, which assumed a global `fetch`; the runtime is
   * built against no DOM or Node library, so the platform hands it over.
   */
  readonly fetch: HttpFetch;
  readonly clock: Clock;
  /**
   * A number in [0, 1) for the backoff's jitter; `Math.random` when absent.
   * Not in the specification's list: a test hands in a deterministic one.
   */
  readonly random?: () => number;
  /** Online or offline, foreground or background: offline parks a connection's retry, a foreground wakeup probes its socket. */
  readonly network: NetworkSignal;
  /** Who this client is, as the environment records it. */
  readonly client: ClientIdentity;
  /** Reads the local environment's bootstrap grant; absent where there is none to read (a browser tab). */
  readonly grant?: GrantReader;
  /** What only a desktop can do; absent in the terminal UI and the browser tab. */
  readonly shell?: Shell;
  /**
   * Hears a fault the runtime has no caller to hand to: a renderer's listener
   * that threw, a background write that failed. Absent, the fault surfaces as
   * an unhandled rejection, which the host reports, once the runtime's own
   * work is done.
   */
  readonly reportError?: (error: unknown) => void;
}

/** The clients the runtime serves. A `program` drives the wire without the runtime. */
export type RuntimeClientKind = "desktop" | "tui" | "web";

export interface ClientIdentity {
  readonly kind: RuntimeClientKind;
  /** A name for the client session, for people: `David's MacBook`. */
  readonly label: string;
  /** The harness version the client was built as, sent in `auth`. */
  readonly version: string;
}

/** JSON documents by key. Values are plain JSON; a document that was never written reads `undefined`. */
export interface DocumentStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Secrets by name. The runtime names a paired connection's client session
 * token by its environment id. The desktop's shell provides one as its
 * `secrets` member (the OS keychain).
 */
export interface SecretStore {
  /** Unavailable access may reject; reconnecting must preserve the saved credential when it does. */
  get(name: string): Promise<string | undefined>;
  set(name: string, secret: string): Promise<void>;
  delete(name: string): Promise<void>;
  /**
   * How a token kept now is protected, which the Your machines card says when it is unprotected (#416). A pairing asks it
   * before it spends its one-use code (#1693): on macOS the answer waits on the Keychain prompt, which a person answers late
   * or not at all. Absent where a store always keeps a token.
   */
  readonly protection?: () => Promise<SecretProtection>;
}

/** What the runtime is told about one WebSocket. */
export interface SocketHandlers {
  onOpen(): void;
  /** A text frame. The wire has no binary frames. */
  onMessage(text: string): void;
  /** The socket closed, cleanly or not; called once, and after a failure to open too. */
  onClose(code: number, reason: string): void;
}

export interface PlatformSocket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

/** Opens a WebSocket to `url` (`ws://host:port/ws`), reporting to `handlers`. */
export type WebSocketFactory = (url: string, handlers: SocketHandlers) => PlatformSocket;

export interface HttpRequest {
  readonly method?: "GET" | "POST";
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

/** A `fetch` reduced to what the runtime uses; the standard `fetch` is one. Rejects when nothing answers. */
export type HttpFetch = (url: string, request?: HttpRequest) => Promise<HttpResponse>;

export interface Timer {
  cancel(): void;
}

/** Time, for timestamps and every timer the runtime sets: it calls no global timer. */
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): Timer;
}

export interface NetworkState {
  readonly online: boolean;
  readonly foreground: boolean;
}

/** The network as the platform sees it: online or offline, and whether the client is in the foreground. */
export type NetworkSignal = Observable<NetworkState>;

/**
 * Reads the credential-access record the local environment writes while its
 * start waits on the person to let it read its stored key (#1689): the
 * record and whether its process is still alive, undefined when there is
 * none. The desktop's shell provides one as its `credentialAccess` member.
 */
export interface CredentialAccessReader {
  read(): Promise<LocalCredentialAccess | undefined>;
}

/** The local environment's credential-access record, and whether the start that wrote it still runs: a dead one's wait ended unanswered. */
export type LocalCredentialAccess = CredentialAccessRecord & { readonly live: boolean };

/** Reads the grant file the local environment writes. The desktop's shell provides one as its `localGrant` member. */
export interface GrantReader {
  /** The grant as it is now; undefined when there is none, as when the service is not running. */
  read(): Promise<BootstrapGrant | undefined>;
}
