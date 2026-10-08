import {
  forgeAccountOnHost,
  type ForgeAccountRecord,
  type ForgeAccountUpdatedPayload,
  type ForgeAccountVerifiedPayload,
  type ForgeCapabilityName,
  type ForgeKind,
} from "@agent-harness/contracts";
import type { ForgeOrigin } from "@agent-harness/contracts";
import { formatActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import type { ForgeCredential } from "./forge-service.js";
import { listForgeAccounts, liveForgeAccount } from "./forge-store.js";
import type { ForgeProvider } from "./providers.js";
import { NOTHING_KNOWN, reconcile, verifyCredential, type Found, type Reconciled } from "./verification.js";

/**
 * The forge accounts' verification schedule and its record (forge spec,
 * "Verification"; ADR 0020, ADR 0031), as the account store keeps its
 * status reads (#134):
 *
 * - **When.** Every forge account after startup's gate, then fifteen
 *   minutes after each verification ends, on the environment's clock; at
 *   once when it is given a credential (added with one, or its credential
 *   replaced); and whenever `forge.accounts.verify` asks. A copy with no
 *   credential is never verified, nor one whose credential answered as
 *   another user, until that credential is replaced.
 * - **One at a time per forge account.** A request while one runs for the
 *   same credential joins it; one for a credential given since waits for
 *   it and verifies again, so a replaced credential's findings are never
 *   taken for the new one's.
 * - **Within the budget.** Ten seconds (ADR 0031's) from reading the
 *   credential to the last answer, past which the forge account is
 *   `unreachable` and nothing else it found is taken.
 * - **Rate limits** a forge asks for, of a verification or of any other
 *   operation with the forge account's credential, pause the forge
 *   account's scheduled verifications until then, and Set up's (below); a
 *   request that is asked for still runs, and a credential given ends the
 *   pause its predecessor drew.
 * - **Set up's Forges checks** (#680) read what the last verification
 *   found while it ended within the age they give, the Forges step's
 *   cadence when the environment checks the step itself, and ask for a
 *   verification only otherwise, as `verify` does, never while a pause
 *   holds: the schedule here stays the forge accounts' own, and the step's
 *   checks add none beside it.
 * - **Recorded only on a change.** `forge.account.verified`, as
 *   `system:forge` with no command id, when the identity, a capability, the
 *   token information or the problem's kind changed; `forge.account.updated`
 *   with the aliases when one became verified or stopped being. The times
 *   each read and alias was last found verified are kept beside the record,
 *   in memory, so a verification that finds nothing new appends nothing and
 *   never moves when the status last changed; so is when an operation last
 *   found a write capability verified (#316).
 */

/** The longest a forge account goes without a verification (ADR 0020). */
export const VERIFY_INTERVAL_MS = 15 * 60_000;

/** The verifications' own actor. */
export const FORGE_ACTOR = formatActor({ kind: "system", id: "forge" });

/** Reads a forge account's credential for one operation, as the ForgeService reads it for every operation. */
export type ReadCredential = (account: ForgeAccountRecord, purpose: string) => Promise<ForgeCredential>;

export interface VerifierOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly stream: StreamRef;
  readonly reader: Reader;
  readonly provider: (kind: ForgeKind) => ForgeProvider;
  readonly readCredential: ReadCredential;
  /** The repository identities this environment knows (`https://<host>/<owner>/<name>`), most recently used first. */
  readonly knownRepositories: () => readonly string[];
  /** How long one verification may take, from reading the credential to its last answer. */
  readonly budgetMs: number;
  /** Told once a verification's record has committed with a login other than the one it had. */
  readonly loginChanged: (account: ForgeAccountRecord) => void;
}

export interface Verifier {
  /** After startup's gate: every forge account now, then every fifteen minutes. */
  start(): void;
  /** Verifies the forge account now, joining one running for the same credential; settles once what it found is recorded. */
  verify(forgeAccountId: string): Promise<void>;
  /** The forge account was given a credential: it is verified at once, on the environment's clock. */
  credentialGiven(forgeAccountId: string): void;
  /** The forge account was removed: its schedule, pause and verified-at times are let go. */
  removed(forgeAccountId: string): void;
  /** `record` with the verified-at times kept beside it. */
  seen(record: ForgeAccountRecord): ForgeAccountRecord;
  /** Holds the forge account's scheduled verifications until `until`, as the forge asked of `account`'s credential; a credential replaced since draws none. */
  pause(account: ForgeAccountRecord, until: Date): void;
  /** An operation found `capability` verified at `at`: the record answers that time from now on. */
  used(forgeAccountId: string, capability: ForgeCapabilityName, at: string): void;
  /**
   * Verifies the forge account as `verify` does unless its last
   * verification's findings stand: it ended less than `maxAgeMs` ago, or
   * the forge asked for a pause that has not passed. Set up's Forges checks
   * ask through it (#680).
   */
  verifyStale(forgeAccountId: string, maxAgeMs: number): Promise<void>;
  /** One verification of a token no forge account holds, within the budget, recording nothing: what it makes of nothing known. */
  probe(request: ProbeRequest): Promise<Reconciled>;
  /** Stops the schedule; a verification still running, one queued behind it and a rate limit heard after record nothing and read nothing, as the event log closes after. */
  close(): void;
}

/** A token to verify with no forge account: the origin and kind it is for, and a repository there (`owner/name`) to probe the reads on, or null. */
export interface ProbeRequest {
  readonly origin: ForgeOrigin;
  readonly kind: ForgeKind;
  readonly token: string;
  readonly repository: string | null;
}

/** When each read and alias of a forge account was last found verified, beside its record. */
interface Seen {
  readonly capabilities: Map<string, string>;
  readonly aliases: Map<string, string>;
}

const later = (one: string | null, other: string | undefined): string | null => (one === null || other === undefined || one >= other ? one : other);

/** A repository identity's host and `owner/name`; null for one that names no repository a provider reads. */
const IDENTITY = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)$/;

export const createVerifier = (options: VerifierOptions): Verifier => {
  const { log, clock, stream, reader, budgetMs } = options;
  const timers = new Map<string, Timer>();
  const runs = new Map<string, { readonly credential: string; readonly done: Promise<void> }>();
  const pausedUntil = new Map<string, number>();
  /** When each forge account's last verification recorded what it found, on the environment's clock; none since its credential was given. */
  const lastEnded = new Map<string, number>();
  const seenTimes = new Map<string, Seen>();
  let closed = false;

  /** Whether a forge account is verified at all: not a copy awaiting a credential, nor one answering as another user until it is replaced. */
  const verifiable = (account: ForgeAccountRecord): boolean => account.credential.kind !== "none" && account.problem?.kind !== "identity-changed";

  /** What names a forge account's credential: a replacement is another credential, whose findings are its own. */
  const credentialOf = (account: ForgeAccountRecord): string => JSON.stringify(account.credential);

  const timesOf = (forgeAccountId: string): Seen => {
    const times = seenTimes.get(forgeAccountId) ?? { capabilities: new Map(), aliases: new Map() };
    seenTimes.set(forgeAccountId, times);
    return times;
  };

  const seen = (record: ForgeAccountRecord): ForgeAccountRecord => {
    const times = seenTimes.get(record.id);
    if (times === undefined) return record;
    const capabilities = { ...record.capabilities };
    for (const [name, at] of times.capabilities) {
      const capability = capabilities[name as keyof typeof capabilities];
      if (capability.state === "verified") capabilities[name as keyof typeof capabilities] = { ...capability, verifiedAt: later(capability.verifiedAt, at) };
    }
    const aliases = record.aliases.map((alias) => (alias.verifiedAt === null ? alias : { ...alias, verifiedAt: later(alias.verifiedAt, times.aliases.get(alias.origin)) }));
    return { ...record, capabilities, aliases };
  };

  /** The repository both reads are probed on: the most recently used one this environment knows whose host is this forge account's. */
  const knownRepository = (account: ForgeAccountRecord): string | null => {
    const accounts = listForgeAccounts(reader).map((each) => ({
      id: each.id,
      origin: each.origin,
      aliases: each.aliases.filter((alias) => alias.verifiedAt !== null).map((alias) => alias.origin),
    }));
    for (const identity of options.knownRepositories()) {
      const [, host, fullName] = IDENTITY.exec(identity) ?? [];
      if (host !== undefined && fullName !== undefined && forgeAccountOnHost(host, accounts)?.id === account.id) return fullName;
    }
    return null;
  };

  /** Settles as `work` does, or as unreachable once the budget has passed, when the work's signal is aborted too. */
  const withinBudget = async (origin: ForgeOrigin, work: (signal: AbortSignal) => Promise<Found>): Promise<Found> => {
    const controller = new AbortController();
    const overrun = new Promise<Found>((resolve) => {
      controller.signal.addEventListener("abort", () =>
        resolve({ outcome: "unreachable", message: `The forge at ${origin} did not finish answering within ${budgetMs / 1000} s.` }),
      );
    });
    // On the wall clock, never the environment's, which a test may hold still.
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref();
    try {
      return await Promise.race([work(controller.signal), overrun]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Holds the forge account's scheduled verifications until `until`, as the forge asked of `account`'s credential; a credential replaced since draws none. */
  const pause = (account: ForgeAccountRecord, until: Date): void => {
    // Nothing is scheduled once closed, and the event log may be closed too.
    if (closed) return;
    const current = liveForgeAccount(reader, account.id);
    if (current === null || credentialOf(current) !== credentialOf(account)) return;
    pausedUntil.set(account.id, Math.max(pausedUntil.get(account.id) ?? 0, until.getTime()));
  };

  /** What the forge answers of the forge account's credential now. */
  const ask = async (account: ForgeAccountRecord, signal: AbortSignal): Promise<Found> => {
    // Read before the credential, whose read may outlast the environment's close, and the event log's with it.
    const repository = knownRepository(account);
    const credential = await options.readCredential(account, "verify");
    if (credential.outcome === "unavailable") return credential;
    try {
      return await verifyCredential(
        options.provider(account.kind),
        { origin: account.origin, token: credential.token, expected: account.identity, repository, aliases: account.aliases.map((alias) => alias.origin) },
        { signal, onPause: (until) => pause(account, until) },
      );
    } finally {
      credential.release();
    }
  };

  /** Records what `found` changed of the forge account as it is now, unless it was removed or given another credential meanwhile. */
  const record = (forgeAccountId: string, credential: string, found: Found): void => {
    const recorded = log.atomically((tx): { readonly before: ForgeAccountRecord; readonly after: Reconciled } | null => {
      const current = liveForgeAccount(reader, forgeAccountId);
      if (current === null || credentialOf(current) !== credential) return null;
      const before = seen(current);
      const after = reconcile(before, found, clock.now(), { origin: current.origin });
      if (after.changed) {
        const payload: ForgeAccountVerifiedPayload = {
          forgeAccountId,
          identity: after.identity,
          capabilities: after.capabilities,
          tokenInformation: after.tokenInformation,
          problem: after.problem,
        };
        log.append(stream, [{ type: "forge.account.verified", payload }], { tx, actor: FORGE_ACTOR });
      }
      if (after.aliasesChanged) {
        const payload: ForgeAccountUpdatedPayload = { forgeAccountId, aliases: [...after.aliases] };
        log.append(stream, [{ type: "forge.account.updated", payload }], { tx, actor: FORGE_ACTOR });
      }
      return { before, after };
    });
    if (recorded === null) return;
    lastEnded.set(forgeAccountId, clock.now().getTime());
    const { before, after } = recorded;
    const times = timesOf(forgeAccountId);
    for (const [name, capability] of Object.entries(after.capabilities)) if (capability.state === "verified" && capability.verifiedAt !== null) times.capabilities.set(name, capability.verifiedAt);
    for (const alias of after.aliases) if (alias.verifiedAt !== null) times.aliases.set(alias.origin, alias.verifiedAt);
    if (after.identity !== null && before.identity !== null && after.identity.login !== before.identity.login) {
      const account = liveForgeAccount(reader, forgeAccountId);
      if (account !== null) options.loginChanged(account);
    }
  };

  const verifyNow = async (forgeAccountId: string): Promise<void> => {
    // This verification is the one that was due: the schedule starts again from its end.
    timers.get(forgeAccountId)?.cancel();
    timers.delete(forgeAccountId);
    // Queued behind a verification that outlasted the close: the event log may be closed too.
    if (closed) return;
    const account = liveForgeAccount(reader, forgeAccountId);
    if (account === null || !verifiable(account)) return;
    const found = await withinBudget(account.origin, (signal) => ask(account, signal));
    if (closed) return;
    record(forgeAccountId, credentialOf(account), found);
  };

  /** Schedules the forge account's next verification `ms` from now, unless one is due sooner: a credential given while one ran. */
  const arm = (forgeAccountId: string, ms: number): void => {
    if (closed || timers.has(forgeAccountId)) return;
    timers.set(forgeAccountId, clock.setTimeout(() => due(forgeAccountId), ms));
  };

  /** A scheduled verification fell due: run it, unless the forge asked for a pause, which it waits out. */
  const due = (forgeAccountId: string): void => {
    timers.delete(forgeAccountId);
    const until = pausedUntil.get(forgeAccountId) ?? 0;
    const now = clock.now().getTime();
    if (until > now) return arm(forgeAccountId, until - now);
    pausedUntil.delete(forgeAccountId);
    void verify(forgeAccountId);
  };

  const verify = (forgeAccountId: string): Promise<void> => {
    const account = liveForgeAccount(reader, forgeAccountId);
    if (account === null || !verifiable(account) || closed) return Promise.resolve();
    const credential = credentialOf(account);
    const running = runs.get(forgeAccountId);
    if (running?.credential === credential) return running.done;
    const done: Promise<void> = (running?.done ?? Promise.resolve())
      .then(() => verifyNow(forgeAccountId))
      .catch((error: unknown) => console.error(`Verifying the forge account ${account.slug} failed:`, error))
      .finally(() => {
        if (runs.get(forgeAccountId)?.done === done) runs.delete(forgeAccountId);
        // Closed, the event log may be too: nothing is read, and nothing is scheduled.
        if (closed) return;
        const after = liveForgeAccount(reader, forgeAccountId);
        if (after !== null && verifiable(after)) arm(forgeAccountId, VERIFY_INTERVAL_MS);
      });
    runs.set(forgeAccountId, { credential, done });
    return done;
  };

  return {
    start() {
      for (const account of listForgeAccounts(reader)) if (verifiable(account)) arm(account.id, 0);
    },
    verify,
    verifyStale(forgeAccountId, maxAgeMs) {
      const now = clock.now().getTime();
      const ended = lastEnded.get(forgeAccountId);
      // A last end later than now (a clock set back) stands for nothing, as the Set up scheduler counts such a result due.
      const fresh = ended !== undefined && now >= ended && now - ended < maxAgeMs;
      if (fresh || (pausedUntil.get(forgeAccountId) ?? 0) > now) return Promise.resolve();
      return verify(forgeAccountId);
    },
    credentialGiven(forgeAccountId) {
      timers.get(forgeAccountId)?.cancel();
      timers.delete(forgeAccountId);
      // A pause was asked of the credential replaced: the one given is verified at once, and a forge that limits it asks again.
      pausedUntil.delete(forgeAccountId);
      // What was found is the replaced credential's: Set up's checks wait for the one given.
      lastEnded.delete(forgeAccountId);
      arm(forgeAccountId, 0);
    },
    removed(forgeAccountId) {
      timers.get(forgeAccountId)?.cancel();
      timers.delete(forgeAccountId);
      pausedUntil.delete(forgeAccountId);
      lastEnded.delete(forgeAccountId);
      seenTimes.delete(forgeAccountId);
    },
    seen,
    pause,
    used(forgeAccountId, capability, at) {
      if (liveForgeAccount(reader, forgeAccountId) !== null) timesOf(forgeAccountId).capabilities.set(capability, at);
    },
    async probe({ origin, kind, token, repository }) {
      const found = await withinBudget(origin, (signal) =>
        verifyCredential(options.provider(kind), { origin, token, expected: null, repository, aliases: [] }, { signal }),
      );
      // No forge account holds the token yet: its lines say what happened, and no remedy.
      return reconcile(NOTHING_KNOWN, found, clock.now(), { origin, remedies: false });
    },
    close() {
      closed = true;
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
};
