import {
  FORGE_EVENT_PAYLOADS,
  KEY_MANAGER_EVENT_PAYLOADS,
  KEY_MANAGER_MOVE_EVENT_PAYLOADS,
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
  /** How long a request waits for its answer. Preset `REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  capability(environmentId: string, method: MethodName): CapabilityAnswer;
  /** A request on the environment's ready socket; rejects when there is none, or when it closes first. */
  request(environmentId: string, method: string, params: Record<string, unknown>): Promise<ResponseFrame>;
}

const failed = (code: RequestFailureCode, message: string, data?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(data && { data }) } }) as const;

export const createRequests = (host: RequestsHost): Pick<Requests, "call"> => ({
  async call<N extends MethodName>(environmentId: string, method: N, params: ParamsOf<N>): Promise<RequestAnswer<N>> {
    const timeoutMs = host.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const entry = registry[method];
    if (entry.kind === "stream") return failed("unsupported", `${method} is a subscription; the runtime subscribes to it itself.`);
    if (OUTBOX_SCOPES.has(entry.scope)) return failed("outbox", `${method} is a ${entry.scope} command; it is sent through the outbox, never as a direct request.`);
    const capability = host.capability(environmentId, method);
    // A connection on its way to `ready` (connecting, starting, updating) holds nothing for later: it is unreachable now.
    if (capability.status === "absent") return failed(capability.reason === "not-ready" ? "unreachable" : capability.reason, capability.message);
    const checked = entry.params.safeParse(params);
    if (!checked.success) return failed("invalid_params", `The params are not ${method}'s: ${checked.error.issues.map((i) => i.message).join("; ")}`);

    let timer: { cancel(): void } | undefined;
    const timeout = new Promise<"timeout">((resolve) => (timer = host.clock.setTimeout(() => resolve("timeout"), timeoutMs)));
    let response: ResponseFrame | "timeout";
    try {
      response = await Promise.race([host.request(environmentId, method, checked.data as Record<string, unknown>), timeout]);
    } catch (error) {
      return failed("unreachable", error instanceof Error ? error.message : String(error));
    } finally {
      timer?.cancel();
    }
    if (response === "timeout") return failed("timeout", `The environment did not answer ${method} within ${timeoutMs / 1000} seconds.`);
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

/** Every key-manager event: a connection's (`key-manager.connection.*`) and Move's. */
const KEY_MANAGER_EVENTS: readonly string[] = [...Object.keys(KEY_MANAGER_EVENT_PAYLOADS), ...Object.keys(KEY_MANAGER_MOVE_EVENT_PAYLOADS)];

/** What changes a trust key's decision, or the key itself: a decision recorded or revoked, and a forge account's aliases, whose canonical host a key is read on. */
const TRUST_REFRESH_NOTICES: readonly string[] = ["trust.updated", "forge.account.added", "forge.account.updated", "forge.account.verified", "forge.account.removed"];

/** Every forge account event: an account added, updated, verified or removed. */
const FORGE_ACCOUNT_EVENTS: readonly string[] = Object.keys(FORGE_EVENT_PAYLOADS).filter((type) => type.startsWith("forge.account."));

/**
 * What changes the user layer's rows or a preview's text: an owned instruction, the orientation switch (a setting), an
 * account, which every row carries and the block names, and what the block's forges and key managers sections read: a
 * forge account, a key-manager connection and the managed tools, whose rows give each connection's CLI.
 */
const INSTRUCTION_REFRESH_NOTICES: readonly string[] = ["instructions.updated", "settings.changed", "account.updated", ...FORGE_ACCOUNT_EVENTS, ...KEY_MANAGER_EVENTS, "tools.updated"];

/**
 * The notices after which one query's cached answer is fetched again: its
 * matching notices (#142). An account changing (`account.updated`: its
 * status, identity, label, or its removal) or a sign-in moving
 * (`signin.updated`, whose end changes an account) changes the accounts, the
 * models they can use and their plan usage; `usage.updated` (#136) a
 * reading, and so the hand-off recommendation made from the readings; a
 * prompt parking or resolving (`prompt.parked`, `prompt.resolved`, #130)
 * the parked prompts; a sign-in moving (`signin.updated`, which carries it)
 * the environment's sign-in, which a client attending it follows for its
 * verification URL and its end (#147); every step of an update (pending,
 * started, updated, failed, cancelled) `updates.status`, which the card and
 * About follow (#344); every `forge.account.*` event the forge accounts
 * (#320), a missing origin (`forge.origin-missing`) changing none of them;
 * and settings changing (`settings.changed`, appended with every
 * `settings.updated`, #391) the settings, read through `settings.get` and,
 * for the permission keys and the containment the status line shows,
 * `permissions.settings.get`; and the skill set changing
 * (`skills.updated`, a command or a read of the own directory, #494)
 * `skills.get`; a trust decision recorded or revoked (`trust.updated`,
 * #500) `trust.get` and `trust.list`, as does a forge account added,
 * updated, verified or removed, since a key is read on the canonical host
 * of a verified alias; an owned instruction changing
 * (`instructions.updated`, #505), a setting (the orientation switch), an
 * account, a forge account, a key-manager connection or the managed tools
 * (what the block's sections read) `instructions.list` and
 * `instructions.preview`, and an owned instruction changing alone
 * `instructions.diff` (#509: a copy's version resolved or its body edited;
 * the catalogue changes only with the build); every key-manager event, a connection's and Move's, the
 * key-manager connections and the items Move lists (#384), and a forge
 * account's added, updated or removed those items too, since a forge
 * account holding a stored token is one; a probe changing managed-tool
 * rows (`tools.updated`) the managed tools (#384) and the key-manager
 * connections, each carrying its CLI's row (#375); an unpaired extension
 * opening its socket (`extension.seen`, #547) `browser.status`, whose
 * unpaired flag ticks the Browser card's Load sub-step; an import of an
 * adopted account's directory ending (`carry-over.imported`, #578), a
 * memory folder assigned (`carry-over.memory-assigned`, #580) and the
 * skill set changing (`skills.updated`, whose own directory the skills
 * count is read against, #580) Carry over's inventory, whose new sessions,
 * memory and skills they change; a state import
 * ending (`state-import.finished`, #581) the state import's detection; and a
 * paired Chrome's pairing, rename, unpairing, connection, disconnection or
 * version report (`chrome.updated`, #548) `browser.chromes.list`, and
 * `browser.status`, whose unpaired flag a pairing clears; and a drain
 * beginning (`environment.draining`, #417) `environment.status`.
 */
export const QUERY_REFRESH_NOTICES: Partial<Readonly<Record<QueryMethodName, readonly string[]>>> = {
  "accounts.list": ["account.updated", "signin.updated"],
  "models.list": ["account.updated", "signin.updated"],
  "accounts.probe": ["account.updated", "signin.updated"],
  "accounts.usage": ["usage.updated", "account.updated", "signin.updated"],
  "accounts.handoff.recommend": ["usage.updated", "account.updated", "signin.updated"],
  "permissions.prompts.list": ["prompt.parked", "prompt.resolved"],
  "accounts.signin.get": ["signin.updated"],
  "updates.status": ["environment.update-pending", "environment.update-started", "environment.updated", "environment.update-failed", "environment.update-cancelled"],
  "forge.accounts.list": FORGE_ACCOUNT_EVENTS,
  "settings.get": ["settings.changed"],
  "permissions.settings.get": ["settings.changed"],
  "skills.get": ["skills.updated"],
  "trust.get": TRUST_REFRESH_NOTICES,
  "trust.list": TRUST_REFRESH_NOTICES,
  "instructions.list": INSTRUCTION_REFRESH_NOTICES,
  "instructions.preview": INSTRUCTION_REFRESH_NOTICES,
  "instructions.diff": ["instructions.updated"],
  "keyManagers.list": [...KEY_MANAGER_EVENTS, "tools.updated"],
  "keyManagers.move.list": [...KEY_MANAGER_EVENTS, "forge.account.added", "forge.account.updated", "forge.account.removed"],
  "tools.list": ["tools.updated"],
  "browser.status": ["extension.seen", "chrome.updated"],
  "browser.chromes.list": ["chrome.updated"],
  "carryOver.inventory": ["carry-over.imported", "carry-over.memory-assigned", "skills.updated"],
  "stateImport.detect": ["state-import.finished"],
  "environment.status": ["environment.draining"],
};

export interface RequestCache {
  cached: Requests["cached"];
  /** The last result held for a query, if any: never fetches, and makes no entry. */
  peek<N extends QueryMethodName>(environmentId: string, method: N, params: ParamsOf<N>): ResultOf<N> | null;
  /**
   * When the fetch whose result is held was sent, in milliseconds on this
   * client's clock; null while no result is held. The result is what the
   * environment held at some instant after it: an answer that came after an
   * event was heard may still have been read before that event.
   */
  askedAt<N extends QueryMethodName>(environmentId: string, method: N, params: ParamsOf<N>): number | null;
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
  /** When the fetch that brought that result was sent, in milliseconds on this client's clock. */
  askedAt: number | null;
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
    const asked = clock.now().getTime();
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
        entry.askedAt = asked;
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
      askedAt: null,
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
    askedAt(environmentId, method, params) {
      return entries.get(keyOf({ environmentId, method, params: params as Record<string, unknown> }))?.askedAt ?? null;
    },
    peek(environmentId, method, params) {
      return (entries.get(keyOf({ environmentId, method, params: params as Record<string, unknown> }))?.value.read().result ?? null) as never;
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
