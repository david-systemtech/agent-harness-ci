import {
  isCommand,
  isMethodName,
  registry,
  type MethodName,
  type ParamsOf,
  type Registry,
  type ResponseFrame,
  type ResponseOf,
  type ResultOf,
  type Scope,
} from "@agent-harness/contracts";
import type { AbsentReason, CapabilityAnswer } from "./capabilities.js";
import type { ConnectionRecord } from "./connections/records.js";
import { writable, type Observable, type Writable } from "./observable.js";
import type { Clock, Timer } from "./platform.js";

/**
 * `requests.call` (docs/specs/client-runtime.md, "The offline outbox,
 * receipts and optimistic application"): a direct request to one
 * environment, for the non-mutating methods and for the `admin` calls
 * (`access.*`), which are never queued. A `sessions:write` or `runs:drive`
 * command is refused (`outbox`): every one goes through the outbox's
 * `commands.dispatch`, so none can skip its command-id and receipt rules
 * by being sent here. It asks `capability` first and
 * answers absent-with-reason at once when the connection cannot take it,
 * so nothing is ever held for later (a connection not yet `ready` is
 * `unreachable`, the specification's word, whatever phase it is in); it
 * checks the params and the answer against the method's schemas; and it
 * gives up after `REQUEST_TIMEOUT_MS`.
 *
 * Added by the terminal UI (#143) for `/pair create` and `/environment`'s
 * client sessions, ahead of the outbox ticket (#128), which added the
 * request cache (`cached`, below) and `commands.dispatch` beside it.
 */

/** How long a request waits for its answer. A chosen default (the specification's 30 seconds). */
export const REQUEST_TIMEOUT_MS = 30_000;

/** The scopes whose commands only the outbox sends (docs/specs/client-runtime.md: every `sessions:write` and `runs:drive` call). */
const OUTBOX_SCOPES: ReadonlySet<Scope> = new Set<Scope>(["sessions:write", "runs:drive"]);

/**
 * Why a request has no result: a capability's absent reason (nothing was
 * sent), `outbox` (a command only the outbox sends; nothing was sent),
 * `invalid_params` (the params are not the method's; nothing was sent),
 * `timeout`, `malformed` (the answer is not the method's), or the
 * environment's own error code, passed on as it is; `internal` also when a
 * cached query's call failed in this client, not at the environment.
 */
export type RequestFailureCode = AbsentReason | "outbox" | "invalid_params" | "timeout" | "malformed" | (string & {});

export interface RequestFailure {
  readonly code: RequestFailureCode;
  /** One line for people. */
  readonly message: string;
  /** The environment's structured `data`, when the failure is its error. */
  readonly data?: Record<string, unknown>;
}

/** A query's result as it is; a command's receipt beside its result (`ResponseOf`). */
export type RequestAnswer<N extends MethodName> =
  | { readonly ok: true; readonly result: ResponseOf<N> }
  | { readonly ok: false; readonly error: RequestFailure };

/** The methods that read and answer once: what the request cache keeps. */
export type QueryMethodName = { readonly [N in MethodName]: Registry[N] extends { readonly kind: "query" } ? N : never }[MethodName];

/** A query's answer as the request cache keeps it. */
export interface CachedAnswer<N extends MethodName> {
  /** The last result the environment answered; null until one came. */
  readonly result: ResultOf<N> | null;
  /** When that result came, on this client's clock; null until one came. */
  readonly fetchedAt: string | null;
  /** Why the last fetch failed, the result kept beside it; null when it did not. */
  readonly error: RequestFailure | null;
  /** A fetch is under way. */
  readonly loading: boolean;
}

export interface Requests {
  /**
   * Sends `method` with `params` on the environment's ready socket and
   * answers its response. A stream is refused (`unsupported`): the
   * runtime's subscriptions are its own. A command's params carry the
   * caller's `commandId`.
   */
  call<N extends MethodName>(environmentId: string, method: N, params: ParamsOf<N>): Promise<RequestAnswer<N>>;
  /**
   * The environment's request cache: a query's answer that renderers need
   * continuously (accounts, models, usage, routines, paired Chromes), one
   * per environment, method and params, the same observable for each.
   * Following it fetches the answer when it is older than five minutes (or
   * none came yet), and while followed it is fetched again as the five
   * minutes pass, on every `ready`, and on a notice that says it may have
   * changed; reading it never fetches. A failure keeps the last result
   * beside it. Anything but a query answers `unsupported`.
   */
  cached<N extends QueryMethodName>(environmentId: string, method: N, params: ParamsOf<N>): Observable<CachedAnswer<N>>;
}

export interface RequestsHost {
  readonly clock: Clock;
  capability(environmentId: string, method: MethodName): CapabilityAnswer;
  /** A request on the environment's ready socket; rejects when there is none, or when it closes first. */
  request(environmentId: string, method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
}

const failed = (code: RequestFailureCode, message: string, data?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(data && { data }) } }) as const;

export const createRequests = (host: RequestsHost): Pick<Requests, "call"> => ({
  async call<N extends MethodName>(environmentId: string, method: N, params: ParamsOf<N>): Promise<RequestAnswer<N>> {
    const entry = registry[method];
    if (entry.kind === "stream") return failed("unsupported", `${method} is a subscription; the runtime subscribes to it itself.`);
    if (OUTBOX_SCOPES.has(entry.scope)) return failed("outbox", `${method} is a ${entry.scope} command; it is sent through the outbox, never as a direct request.`);
    const capability = host.capability(environmentId, method);
    // A connection on its way to `ready` (connecting, starting, updating) holds nothing for later: it is unreachable now.
    if (capability.status === "absent") return failed(capability.reason === "not-ready" ? "unreachable" : capability.reason, capability.message);
    const checked = entry.params.safeParse(params);
    if (!checked.success) return failed("invalid_params", `The params are not ${method}'s: ${checked.error.issues.map((i) => i.message).join("; ")}`);

    let timer: { cancel(): void } | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = host.clock.setTimeout(() => resolve("timeout"), REQUEST_TIMEOUT_MS)));
    let response: ResponseFrame | "timeout";
    try {
      response = await Promise.race([host.request(environmentId, method, checked.data as Record<string, unknown>), timeout]);
    } catch (error) {
      return failed("unreachable", error instanceof Error ? error.message : String(error));
    } finally {
      timer?.cancel();
    }
    if (response === "timeout") return failed("timeout", `The environment did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    if (response.error) return failed(response.error.code, response.error.message, response.error.data);
    const schema = isCommand(entry) ? entry.response : entry.result;
    const result = schema.safeParse(response.result);
    if (!result.success) return failed("malformed", `The environment's answer to ${method} is not the method's.`);
    return { ok: true, result: result.data as ResponseOf<N> };
  },
});

/** How long a cached answer is fresh: past it, a followed answer is fetched again. A chosen default. */
export const REQUEST_CACHE_TTL_MS = 5 * 60_000;

/**
 * The notices on the environment's own stream after which every cached
 * answer of that environment is fetched again: it started (after a restart
 * or an update) or was updated, and a newer version may answer otherwise.
 */
export const CACHE_REFRESH_NOTICES: readonly string[] = ["environment.started", "environment.updated"];

/**
 * The notices after which one query's cached answer is fetched again: its
 * matching notice. None is served yet; the workstream that serves a query
 * together with a notice of its change (an account's status, plan usage)
 * names it here.
 */
export const QUERY_REFRESH_NOTICES: Partial<Readonly<Record<QueryMethodName, readonly string[]>>> = {};

export interface RequestCache {
  cached: Requests["cached"];
  /** An event applied to the environment's own stream, which this client had not seen: a matching notice fetches again. */
  noticed(environmentId: string, type: string): void;
  /** Lets go of an environment's answers: it was removed. */
  forget(environmentId: string): void;
  close(): void;
}

interface Cached {
  readonly environmentId: string;
  readonly method: QueryMethodName;
  /** A copy of the caller's params: what is sent, whatever the caller does to its own object afterwards. */
  readonly params: Record<string, unknown>;
  /** The key the entry is held under, fixed when it is made. */
  readonly key: string;
  readonly value: Writable<CachedAnswer<QueryMethodName>>;
  readonly observable: Observable<CachedAnswer<QueryMethodName>>;
  /** When the last result came, in milliseconds on this client's clock. */
  fetchedAt: number | null;
  /** A ready or a notice said the answer may have changed while nobody followed it: the next follower fetches it. */
  stale: boolean;
  inFlight: boolean;
  /** Asked again while a fetch was under way: fetched once more when it ends, if still followed (else the next follower fetches it). */
  again: boolean;
  followers: number;
  timer: Timer | undefined;
}

const NOTHING_YET: CachedAnswer<QueryMethodName> = { result: null, fetchedAt: null, error: null, loading: false };

/** A value's JSON with every object's keys in order, so params written in any order are one key. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${fields
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const createRequestCache = (host: {
  readonly clock: Clock;
  readonly call: Requests["call"];
  readonly records: Observable<readonly ConnectionRecord[]>;
  readonly report: (error: unknown) => void;
}): RequestCache => {
  const { clock } = host;
  const entries = new Map<string, Cached>();
  const phases = new Map<string, string>();
  let closed = false;

  const fresh = (entry: Cached) => !entry.stale && entry.fetchedAt !== null && clock.now().getTime() - entry.fetchedAt < REQUEST_CACHE_TTL_MS;

  /** While followed, the answer is fetched again once it is five minutes old (a failure is tried again after as long). */
  const schedule = (entry: Cached, after: number) => {
    entry.timer?.cancel();
    entry.timer = undefined;
    if (closed || entry.followers === 0) return;
    entry.timer = clock.setTimeout(() => {
      entry.timer = undefined;
      fetch(entry);
    }, Math.max(0, after));
  };

  const fetch = (entry: Cached): void => {
    if (closed || entries.get(entry.key) !== entry) return;
    if (entry.inFlight) {
      entry.again = true;
      return;
    }
    entry.inFlight = true;
    // The fetch's end sets the next timer: one that fired while it was under way would only ask for it again.
    entry.timer?.cancel();
    entry.timer = undefined;
    entry.value.update((value) => ({ ...value, loading: true }));
    const called = host.call(entry.environmentId, entry.method, entry.params as ParamsOf<QueryMethodName>).catch((reason: unknown): RequestAnswer<QueryMethodName> => {
      // A call that rejects (the host itself failed, not the environment answering an error) is a failed attempt like any
      // other: reported, kept beside the last result as `internal`, and tried again as a failed one is.
      host.report(reason);
      return failed("internal", reason instanceof Error ? reason.message : String(reason));
    });
    void called.then((answer) => {
      entry.inFlight = false;
      if (closed || entries.get(entry.key) !== entry) return;
      if (answer.ok) {
        const now = clock.now();
        entry.fetchedAt = now.getTime();
        entry.stale = false;
        entry.value.set({ result: answer.result as ResultOf<QueryMethodName>, fetchedAt: now.toISOString(), error: null, loading: false });
      } else {
        entry.value.update((value) => ({ ...value, error: answer.error, loading: false }));
      }
      if (entry.again) {
        entry.again = false;
        // Nobody follows it any more: nothing is sent for nobody, and its next follower fetches it.
        if (entry.followers > 0) return fetch(entry);
        entry.stale = true;
        return;
      }
      schedule(entry, REQUEST_CACHE_TTL_MS);
    });
  };

  /** The answer may have changed: fetched now if followed, else by its next follower. */
  const refresh = (entry: Cached) => {
    if (entry.followers > 0) fetch(entry);
    else entry.stale = true;
  };

  /** The entry is let go of (its environment removed, the runtime closed): a fetch under way is not waited for. */
  const drop = (entry: Cached) => {
    entry.timer?.cancel();
    entry.timer = undefined;
    entry.again = false;
    if (entry.value.read().loading) entry.value.update((value) => ({ ...value, loading: false }));
  };

  const keyOf = (entry: Pick<Cached, "environmentId" | "method" | "params">) => `${entry.environmentId} ${entry.method} ${canonical(entry.params)}`;

  const make = (environmentId: string, method: QueryMethodName, params: Record<string, unknown>, key: string): Cached => {
    const value = writable<CachedAnswer<QueryMethodName>>(NOTHING_YET, host.report);
    const entry: Cached = {
      environmentId,
      method,
      // A JSON round trip: the params are JSON already (checked against the method's schema), and a shared nested object would let the caller change what is sent under a key fixed at creation.
      params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>,
      key,
      value,
      fetchedAt: null,
      stale: false,
      inFlight: false,
      again: false,
      followers: 0,
      timer: undefined,
      observable: {
        read: value.read,
        subscribe(listener) {
          const stop = value.subscribe(listener);
          entry.followers++;
          if (entry.followers === 1) {
            if (fresh(entry)) schedule(entry, (entry.fetchedAt as number) + REQUEST_CACHE_TTL_MS - clock.now().getTime());
            else fetch(entry);
          }
          let followed = true;
          return () => {
            if (!followed) return;
            followed = false;
            stop();
            entry.followers--;
            if (entry.followers > 0) return;
            // Followed by nobody, it is fetched again by its next follower once it is five minutes old.
            entry.timer?.cancel();
            entry.timer = undefined;
          };
        },
      },
    };
    return entry;
  };

  const stopRecords = host.records.subscribe((records) => {
    for (const record of records) {
      const before = phases.get(record.environmentId);
      phases.set(record.environmentId, record.phase);
      if (record.phase !== "ready" || before === "ready") continue;
      for (const entry of entries.values()) if (entry.environmentId === record.environmentId) refresh(entry);
    }
  });

  return {
    cached(environmentId, method, params) {
      if (!isMethodName(method) || registry[method].kind !== "query") {
        // The same read-only shape as a cached answer's: one that never fetches and never changes.
        const { read, subscribe } = writable<CachedAnswer<QueryMethodName>>({ ...NOTHING_YET, error: { code: "unsupported", message: `${method} is not a query, so it is not cached.` } });
        return { read, subscribe } as never;
      }
      const draft = { environmentId, method, params: params as Record<string, unknown> };
      const key = keyOf(draft);
      let entry = entries.get(key);
      if (!entry) entries.set(key, (entry = make(environmentId, method, draft.params, key)));
      return entry.observable as never;
    },
    noticed(environmentId, type) {
      for (const entry of entries.values()) {
        if (entry.environmentId !== environmentId) continue;
        if (CACHE_REFRESH_NOTICES.includes(type) || (QUERY_REFRESH_NOTICES[entry.method] ?? []).includes(type)) refresh(entry);
      }
    },
    forget(environmentId) {
      for (const [key, entry] of entries) {
        if (entry.environmentId !== environmentId) continue;
        entries.delete(key);
        drop(entry);
      }
      phases.delete(environmentId);
    },
    close() {
      closed = true;
      stopRecords();
      for (const entry of entries.values()) drop(entry);
    },
  };
};
