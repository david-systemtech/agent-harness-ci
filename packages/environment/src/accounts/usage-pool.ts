import {
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  type AccountIdentity,
  type AccountRecord,
  type AccountUsage,
  type PlanLimitPayload,
  type RunStartedPayload,
  type UsageUpdatedPayload,
  type UsageVerdict,
  type UsageWindow,
} from "@agent-harness/contracts";
import type { UsageReading } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import { formatActor, type EventEnvelope, type EventLog } from "../event-log/event-log.js";
import { readRun } from "../runs/run-reads.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import { withTimeout } from "./account-service.js";
import { sameLogin } from "./account-store.js";
import { currentWindow, isFresh, type LiveRunLoad } from "./handoff.js";

/**
 * The environment's plan-usage pool (claude-adapter spec, "Plan usage";
 * ADR 0005, ADR 0018): one reading per account, the source every client
 * reads through `accounts.usage` and the hand-off recommendation answers
 * from.
 *
 * - **Read through the adapter host** (`AdapterHost.usage`), under a
 *   timeout well inside a client's request timeout, so a hung read answers
 *   unavailable rather than failing the call. Concurrent asks for one
 *   account share the read in flight; once a read has timed out the next
 *   ask reads again, though the adapter's may still be running.
 * - **Kept for six minutes from when the provider was read** (the reading's
 *   `readAt`), on the environment's clock, then read again at the next ask.
 *   Ageing from the provider's own stamp rather than from when the pool was
 *   handed the reading is what keeps the adapter's cache (Claude's keeps a
 *   reading six minutes too, `plan-usage.ts`) from doubling the age: a
 *   reading the adapter had kept four minutes is kept two more here, and the
 *   adapter's has aged out by the time the pool asks again. A stamp in the
 *   future, unreadable, or already six minutes old is replaced by the time
 *   it was handed over, so a clock the adapter disagrees with cannot make the
 *   pool read on every ask; the reading then says so, its `readAt` and each
 *   window's `observedAt` rewritten to the hand-over.
 * - **Unavailable, never failing**: an account whose adapter lacks
 *   `planUsage`, one not signed in (not read at all), a read that throws or
 *   times out, and a provider reporting no limits each answer a reading with
 *   no windows and the reason. A failed read is answered and held (so the
 *   notice and the hand-off see it) but read again at the next ask, as the
 *   Claude adapter does not keep a failed read either. It is dated when it
 *   was asked, not when it failed: it read nothing, so a verdict heard while
 *   it was under way is newer and folds in, rather than being lost with the
 *   reading it replaces. A fault around the read, outside the adapter (the
 *   host's account lookup, the store), answers that account unavailable too,
 *   reported and not held: one account's fault never fails the others'
 *   readings.
 * - **A stop ends a read quietly**: once the pool closes, an ask, and a
 *   read that was in flight, answers the stop's `unavailable` ("The
 *   environment is stopping."), touching neither the store nor the log,
 *   which close after it, and reporting nothing (#1899).
 * - **A run's `plan.limit` folds in**: the pool
 *   hears the log, maps the run to its account through the runs table, and
 *   folds the verdict into that account's window: the verdict, and the
 *   utilisation and reset it names, the rest kept unless the window has
 *   rolled over since. A verdict is folded only when it is news, a verdict
 *   changing or a utilisation moving, since a provider reports on every
 *   response. A verdict older than the reading's `readAt` is not folded: the
 *   provider answered the read after it, so the read's numbers are newer
 *   (which is also what keeps a window's `observedAt` never before the
 *   reading's `readAt`). One for an account with no reading is dropped (the
 *   next read is newer); one heard while a read is in flight is folded into
 *   that read's reading on the same rule. The fold does not make a reading
 *   younger: its window's `observedAt` moves, its `readAt` does not.
 * - **`usage.updated`** goes on the environment's stream when a reading
 *   changes: its identity, why it is unavailable, or a window's name,
 *   utilisation (to a whole percent, what a gauge shows), reset or verdict.
 *   The times alone are not a change.
 * - **The identity** is the one the store records for the account when the
 *   provider's read names the same login (the email ignoring case, the
 *   organisation only when both name one), so one login reads as one
 *   identity on every environment; else the one the read gave. A read that
 *   finishes after the store gave the account another identity is answered
 *   but not held.
 * - **Live runs**: the runs started and not yet ended, with their account,
 *   model and effort, from the same log, for the hand-off's load.
 */

/**
 * How long a plan-usage read may take before it counts as failed and the
 * reading answers unavailable: the Claude read spawns a control query, and
 * a client gives up on a request after thirty seconds (client-runtime spec).
 */
export const USAGE_READ_TIMEOUT_MS = 10_000;

/** The pool's own actor, for the `usage.updated` notices. */
export const USAGE_POOL_ACTOR = formatActor({ kind: "system", id: "plan-usage" });

/** A verdict as it folds into a window: what a run's `plan.limit` said, and when. */
export interface PlanVerdict {
  readonly window: string;
  readonly status: UsageVerdict;
  readonly utilisation: number | null;
  readonly resetsAt: string | null;
  /** When the run reported it: the `plan.limit` event's time. */
  readonly at: string;
}

export interface UsagePoolOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment's id: the id of its stream, where the notices go. */
  readonly environmentId: string;
  /** The accounts the environment holds, in the store's order. */
  readonly accounts: { list(): AccountRecord[] };
  readonly host: Pick<AdapterHost, "usage" | "account">;
  /** Preset `USAGE_READ_TIMEOUT_MS`. */
  readonly readTimeoutMs?: number;
}

export interface UsagePool {
  /** The readings of one account or every one, each read again when it is six minutes old; `not_found` for an account not held. */
  read(accountId?: string): Promise<AccountUsage[]>;
  /** The account's reading as the pool holds it, whatever its age; null before its first read. Never reads. */
  cached(accountId: string): AccountUsage | null;
  /** The runs live on the account now. */
  liveRuns(accountId: string): LiveRunLoad[];
  /** Stops hearing the log and noticing. */
  close(): void;
}

interface Held {
  reading: AccountUsage;
  /** When the reading's provider read happened, the age it is kept by, in ms. */
  readonly at: number;
  /** Whether the next ask reads again whatever the age: a failed read, or an account that was not signed in. */
  readonly retry: boolean;
}

interface LiveRun extends LiveRunLoad {
  readonly accountId: string;
}

/**
 * What a read answers once the pool has closed: the environment is stopping,
 * as its other methods and its wire say. Its store and log close next, so a
 * read the stop caught touches neither and is not reported.
 */
const stopping = (): ContractError =>
  new ContractError({ code: "unavailable", message: "The environment is stopping.", data: { readiness: "draining" } });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isoOrNull = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
};

const sameIdentity = (a: AccountIdentity | null, b: AccountIdentity | null): boolean =>
  a === null || b === null ? a === b : a.provider === b.provider && a.email === b.email && a.organisation === b.organisation;

/** A utilisation to the whole percent a gauge shows, so a read that moves it by less is no news. */
const shown = (utilisation: number | null): number | null => (utilisation === null ? null : Math.round(utilisation * 100));

/** Whether two readings say the same: identity, reason, and each window's name, utilisation to a whole percent, reset and verdict; the times aside. */
export const sameReading = (a: AccountUsage, b: AccountUsage): boolean =>
  sameIdentity(a.identity, b.identity) &&
  a.unavailableReason === b.unavailableReason &&
  a.windows.length === b.windows.length &&
  a.windows.every((window, index) => {
    const other = b.windows[index];
    return (
      other !== undefined &&
      window.window === other.window &&
      shown(window.utilisation) === shown(other.utilisation) &&
      window.resetsAt === other.resetsAt &&
      window.verdict === other.verdict
    );
  });

/**
 * A run's verdict folded into a reading, or null when it is not news:
 * neither the verdict nor the utilisation moved, or it is older than the
 * reading, whose read the provider answered after it (a failed read is
 * dated when it was asked, so none heard during it is).
 * The folded window takes the verdict, and the utilisation and reset it
 * names; what it does not name is kept from the window, unless the window
 * rolled over before the verdict, whose numbers describe a period that is
 * over. A reading with no windows for a reason is replaced by one with the
 * window: the provider has just said it limits the account.
 */
export const foldVerdict = (reading: AccountUsage, verdict: PlanVerdict): AccountUsage | null => {
  if (Date.parse(verdict.at) < Date.parse(reading.readAt)) return null;
  const base = reading.unavailableReason === null ? reading.windows : [];
  const current = base.find((window) => window.window === verdict.window) ?? null;
  const statusChanged = verdict.status !== (current?.verdict ?? "allowed");
  const moved = verdict.utilisation !== null && verdict.utilisation !== current?.utilisation;
  if (!statusChanged && !moved) return null;
  const inherited = current !== null && currentWindow(current, Date.parse(verdict.at)) !== null ? current : null;
  const folded: UsageWindow = {
    window: verdict.window,
    utilisation: verdict.utilisation ?? inherited?.utilisation ?? null,
    resetsAt: verdict.resetsAt ?? inherited?.resetsAt ?? null,
    verdict: verdict.status,
    observedAt: verdict.at,
  };
  const windows = current === null ? [...base, folded] : base.map((window) => (window === current ? folded : window));
  return { ...reading, windows, unavailableReason: null };
};

export const createUsagePool = (options: UsagePoolOptions): UsagePool => {
  const { log, clock, environmentId, accounts, host } = options;
  const readTimeoutMs = options.readTimeoutMs ?? USAGE_READ_TIMEOUT_MS;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const held = new Map<string, Held>();
  const inFlight = new Map<string, Promise<AccountUsage>>();
  /** Verdicts heard while a read was in flight: that read began before them, so its reading takes them. */
  const arrivedDuring = new Map<string, PlanVerdict[]>();
  const live = new Map<string, LiveRun>();
  let closed = false;

  const notice = (accountId: string, identity: AccountIdentity | null): void => {
    if (closed) return;
    const payload: UsageUpdatedPayload = { accountId, identity };
    try {
      log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "usage.updated", payload }], { actor: USAGE_POOL_ACTOR });
    } catch (error) {
      console.error(`Noticing the plan usage of account ${accountId} failed:`, error);
    }
  };

  /** Holds a reading, and notices it when it says something the one it replaces did not. */
  const hold = (accountId: string, next: Held): void => {
    const before = held.get(accountId);
    held.set(accountId, next);
    if (before === undefined || !sameReading(before.reading, next.reading)) notice(accountId, next.reading.identity);
  };

  const unavailable = (record: AccountRecord, identity: AccountIdentity | null, readAt: string, reason: string): AccountUsage => ({
    accountId: record.id,
    identity,
    windows: [],
    readAt,
    unavailableReason: reason,
  });

  /** The adapter's reading as the wire carries it, with the identity the store records for the same login, and the age it is kept by. */
  const fromAdapter = (record: AccountRecord, raw: UsageReading, handedAt: number): { reading: AccountUsage; at: number } => {
    const stamped = Date.parse(raw.readAt);
    // A stamp that cannot be aged by is replaced by the hand-over, on the wire too, so the reading says how old it is taken to be.
    const at = Number.isNaN(stamped) || stamped > handedAt || !isFresh(stamped, handedAt) ? handedAt : stamped;
    const readAt = new Date(at).toISOString();
    const identity = record.identity !== null && sameLogin(raw.identity, record.identity) ? record.identity : raw.identity;
    const windows: UsageWindow[] = raw.windows
      .filter((window) => typeof window.window === "string" && window.window !== "")
      .map((window) => ({
        window: window.window,
        utilisation: typeof window.utilisation === "number" && Number.isFinite(window.utilisation) ? Math.max(0, window.utilisation) : null,
        resetsAt: isoOrNull(window.resetsAt),
        verdict: window.verdict ?? null,
        observedAt: readAt,
      }));
    const unavailableReason = windows.length > 0 ? null : raw.unavailableReason !== undefined && raw.unavailableReason !== "" ? raw.unavailableReason : "The provider reported no plan windows.";
    return { reading: { accountId: record.id, identity, windows, readAt, unavailableReason }, at };
  };

  const readOne = (record: AccountRecord): Promise<AccountUsage> => {
    const accountId = record.id;
    const cached = held.get(accountId);
    const now = clock.now().getTime();
    if (cached !== undefined && !cached.retry && isFresh(cached.at, now)) return Promise.resolve(cached.reading);
    const pending = inFlight.get(accountId);
    if (pending !== undefined) return pending;
    const reading = (async (): Promise<AccountUsage> => {
      let next: Held;
      const askedAt = clock.now();
      const descriptor = host.account(accountId)?.descriptor ?? null;
      if (record.status.state !== "signed-in") {
        next = { reading: unavailable(record, record.identity, askedAt.toISOString(), `${record.label} is ${record.status.state}; its plan usage is read once it is signed in.`), at: askedAt.getTime(), retry: true };
      } else if (descriptor === null || !descriptor.planUsage) {
        const name = descriptor?.displayName ?? record.provider;
        next = { reading: unavailable(record, record.identity, askedAt.toISOString(), `The ${name} adapter does not report plan usage.`), at: askedAt.getTime(), retry: false };
      } else {
        try {
          const raw = await withTimeout(() => host.usage(accountId), readTimeoutMs, `The plan-usage read of the account ${record.label}`);
          const handedAt = clock.now().getTime();
          const { reading: mapped, at } = fromAdapter(record, raw, handedAt);
          next = { reading: mapped, at, retry: false };
        } catch (error) {
          if (closed) throw stopping();
          console.error(`Reading the plan usage of the account ${record.label} failed:`, error);
          // Stamped when it was asked, not when it failed: it read nothing, so a verdict heard while it was under way is
          // newer than it and folds in below, rather than being lost with the reading it replaces.
          next = { reading: unavailable(record, record.identity, askedAt.toISOString(), `Could not read plan usage: ${messageOf(error)}`), at: askedAt.getTime(), retry: true };
        }
      }
      // The stop caught the read: the store and the log under it are closing, so it ends here, neither held nor reported.
      if (closed) throw stopping();
      // A verdict heard while the read was under way is newer than it: folded in.
      let folded = next.reading;
      for (const verdict of arrivedDuring.get(accountId) ?? []) folded = foldVerdict(folded, verdict) ?? folded;
      next = { ...next, reading: folded };
      // Held only for the account as it is now: not one removed, nor one the store has since given another identity.
      const current = accounts.list().find((account) => account.id === accountId);
      if (current !== undefined && sameIdentity(current.identity, record.identity)) hold(accountId, next);
      return next.reading;
    })().finally(() => {
      inFlight.delete(accountId);
      arrivedDuring.delete(accountId);
    });
    inFlight.set(accountId, reading);
    return reading;
  };

  /**
   * One account's read, total: a fault outside the adapter's read (the host's
   * account lookup, the store) answers that account unavailable and is
   * reported, rather than failing the other accounts' readings with it. Not
   * held, so the next ask reads again.
   */
  const readTotal = async (record: AccountRecord): Promise<AccountUsage> => {
    try {
      return await readOne(record);
    } catch (error) {
      if (closed) throw stopping();
      console.error(`Reading the plan usage of the account ${record.label} failed in the environment:`, error);
      return unavailable(record, record.identity, clock.now().toISOString(), `Could not read plan usage: ${messageOf(error)}`);
    }
  };

  /** The account a run ran on: the live record, else the runs table. */
  const accountOfRun = (runId: string): string | null => live.get(runId)?.accountId ?? readRun(reader, runId)?.accountId ?? null;

  const fold = (event: EventEnvelope): void => {
    const payload = event.payload as PlanLimitPayload;
    const accountId = accountOfRun(payload.runId);
    if (accountId === null) return;
    const verdict: PlanVerdict = { window: payload.window, status: payload.status, utilisation: payload.utilisation, resetsAt: payload.resetsAt, at: event.occurredAt };
    if (inFlight.has(accountId)) arrivedDuring.set(accountId, [...(arrivedDuring.get(accountId) ?? []), verdict]);
    const current = held.get(accountId);
    if (current === undefined) return;
    const folded = foldVerdict(current.reading, verdict);
    if (folded !== null) hold(accountId, { ...current, reading: folded });
  };

  const unsubscribe = log.subscribe((event) => {
    try {
      if (event.streamKind === "account" && (event.type === "account.removed" || event.type === "account.identity-set")) {
        // A reading of a login the account no longer has, or of an account no longer held, is not kept.
        held.delete(event.streamId);
        return;
      }
      if (event.streamKind !== "session") return;
      if (event.type === "run.started") {
        const started = event.payload as RunStartedPayload;
        live.set(started.runId, { accountId: started.accountId, model: started.model, effort: started.effort });
      } else if (event.type === "run.ended") live.delete(String(event.payload["runId"]));
      else if (event.type === "plan.limit") fold(event);
    } catch (error) {
      console.error(`The plan-usage pool could not take event ${event.sequence} (${event.type}):`, error);
    }
  });

  return {
    async read(accountId) {
      if (closed) throw stopping();
      const records = accounts.list();
      const chosen = accountId === undefined ? records : records.filter((record) => record.id === accountId);
      if (accountId !== undefined && chosen.length === 0) {
        throw new ContractError({ code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } });
      }
      return Promise.all(chosen.map(readTotal));
    },
    cached: (accountId) => held.get(accountId)?.reading ?? null,
    liveRuns: (accountId) => [...live.values()].filter((run) => run.accountId === accountId).map(({ model, effort }) => ({ model: model ?? null, effort: effort ?? null })),
    close() {
      closed = true;
      unsubscribe();
    },
  };
};
