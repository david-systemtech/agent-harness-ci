import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  AccountLabel,
  ContractError,
  ENVIRONMENT_STREAM_KIND,
  invalidParams,
  PRODUCT_NAME,
  type AccountCatalogue,
  type AccountChange,
  type AccountIdentity,
  type AccountRecord,
  type AccountStatusState,
  type AccountUpdatedPayload,
  type AmbientProbe,
  type AuthStatus,
  type SignInStart,
} from "@agent-harness/contracts";
import type { AccountRef, Adapter, ModelCatalogue } from "../adapter/contract.js";
import { ProbeTimeoutError } from "../adapter/probe.js";
import { createAdapterRegistry, type AdapterRegistry } from "../adapter/registry.js";
import { formatActor, type EventInput, type EventLog, type StreamRef } from "../event-log/event-log.js";
import { dropAccountInjection } from "../key-managers/injection-setting.js";
import type { AccountFacts } from "../runs/run-decider.js";
import type { Clock, Timer } from "../serve/clock.js";
import { isDirectory } from "../serve/files.js";
import type { CommandAnswer, CommandContext } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import {
  accountByDirectory,
  accountByIdentity,
  accountByLabel,
  accountStream,
  anyAccountEver,
  listAccounts,
  liveAccount,
  readAccount,
  sameIdentity,
  sameLogin,
} from "./account-store.js";
import { signInUnavailable, type SignInDirector, type SignInDirectorFactory, type SignInOutcome } from "./signin-seam.js";

/**
 * The account service (claude-adapter spec, "The account store" and "Sign-in
 * and status through the bundled binary"; ADR 0018, ADR 0011): the rules
 * over the account store, and what the adapter host looks an account up
 * through when a run starts.
 *
 * - **Adopt** registers the machine's own provider directory in place,
 *   from its latest read, and never touches it: nothing in it is moved,
 *   linked or deleted, now or on removal.
 * - **Add** makes an owned directory under `<data dir>/accounts/<id>` and
 *   hands the account to the sign-in director (#135), which the
 *   `accounts.signin.*` methods drive through `signIn`.
 * - **One identity is one account**: an owned account whose first identity
 *   (the sign-in's, read before it ever read as signed in) is one another
 *   account holds is refused, "already added as <label>", removed and its
 *   directory deleted; adopting a directory signed in as a held identity is
 *   rejected the same way.
 * - **Deleting** reaches only an owned directory, under the data directory,
 *   that no account the environment holds and no provider's own directory
 *   is, holds or lies inside.
 * - **Status** is read at startup, when `accounts.refresh` asks, and at most
 *   every fifteen minutes otherwise: one timer per account on the
 *   environment's clock, armed at each read. A change of state (signed in,
 *   signed out, expired, unreadable) is `account.status-changed`, appended
 *   only on a change, a new identity `account.identity-set`.
 * - **Notices**: once a change has committed, an `account.updated` goes on
 *   the environment's stream for `environment.subscribe`; the reads startup
 *   makes, before the wire opens, notice nothing (`environment.started`
 *   follows them).
 * - A run's provider naming another login than the store holds (Claude's
 *   `accountInfo`) is an `account.updated` with a warning, and a fresh read.
 */

/** Where owned account directories live under the data directory. */
export const ACCOUNTS_DIRECTORY = "accounts";

/** How long a status or model probe may take before it counts as failed, so a hung probe cannot hang startup or a read. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Retry temporary provider deadlines promptly, without a tight startup loop. */
export const PROBE_RETRY_INTERVAL_MS = 30_000;

/** The longest an account goes without a status read (ADR 0011, ADR 0018). */
export const STATUS_READ_INTERVAL_MS = 15 * 60_000;

/** The account store's own actor: status reads, a refused sign-in, the accounts carried over from configuration. */
export const ACCOUNT_STORE_ACTOR = formatActor({ kind: "system", id: "account-store" });

/**
 * An account as #119 configured it: carried over into the store as adopted
 * in place, under its own id and with its id as its label, when the store
 * has never held an account. Its directory is the given one, else the
 * provider's own.
 */
export interface ConfiguredAccount {
  readonly id: string;
  readonly provider: string;
  readonly directory?: string | null;
}

/** The Account step's settings, as the service and the runs read them. */
export interface AccountDefaults {
  readonly account: string | null;
  readonly modelFamily: string | null;
  readonly effort: string | null;
}

const NO_DEFAULTS: AccountDefaults = { account: null, modelFamily: null, effort: null };

export interface AccountServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly adapters: readonly Adapter[];
  /** The environment's id: the id of its stream, where the `account.updated` notices go. */
  readonly environmentId: string;
  /** Where owned directories are made (`<data dir>/accounts`); null for an environment with none, which cannot add. */
  readonly ownedRoot: string | null;
  /** The sign-in director's factory; preset: `signInUnavailable` (the environment passes the real director). */
  readonly signIn?: SignInDirectorFactory;
  /** Preset `PROBE_TIMEOUT_MS`. */
  readonly probeTimeoutMs?: number;
  /** Accounts carried over from configuration (#119) the first time the environment starts with them. */
  readonly configured?: readonly ConfiguredAccount[];
  /** The Account step's settings as they are now; preset: none set. */
  readonly defaults?: () => AccountDefaults;
}

/** What an adapter host reads an account through (`host.ts`): the account seam #119 left. */
export interface HostAccounts {
  /** The account `id` names as a run needs it: its directory, whether it is signed in, as whom, its adapter and models; null when the environment does not hold it. */
  facts(id: string): AccountFacts | null;
  /** The environment's default account: `accounts.defaultAccount` while the environment holds it, else the first adopted or added. */
  defaultId(): string | null;
  /** The Account step's settings a run defaults from. */
  defaults(): AccountDefaults;
  /** The provider of an account the store holds or held, so a session of a removed account still reaches its adapter; null for one it never held. */
  providerOf(id: string): string | null;
  /** A run's provider says who the run is signed in as: checked against the store's identity. */
  crossCheck(accountId: string, identity: AccountIdentity, runId: string): void;
  /** A run's provider found the account unable to sign in: its status is read again now, and a change noticed (#229). */
  recheck(accountId: string): void;
}

/** How an account command is refused: an account the environment does not hold, or a rule it breaks. */
type Refused = "not_found" | "conflict";

export interface AccountService extends HostAccounts {
  /** The sign-in director the store handed its port to: what the `accounts.signin.*` methods drive. */
  readonly signIn: SignInDirector;
  /** Carries over the configured accounts, reads the machine's own directories and every account's status and models, and removes owned directories whose deletion was recorded; startup runs it once. */
  start(): Promise<void>;
  /** The accounts, each with its latest read time. */
  list(): AccountRecord[];
  /** Reads the machine's own provider directory now (`accounts.probe`). */
  probe(provider?: string): Promise<AmbientProbe>;
  /** Read a validated import source without probing sign-in or refreshing credentials. Does not authorise ambient adoption. */
  observeDirectory(params: { readonly provider: string; readonly directory: string }): Promise<AccountDirectoryObservation>;
  /** Reads one account's status and models now, or every account's (`accounts.refresh`); answers the accounts after it. */
  refresh(accountId?: string): Promise<AccountRecord[]>;
  /** The models of one account or of every one (`models.list`), read first for an account never read. */
  catalogues(accountId?: string): Promise<AccountCatalogue[]>;
  adopt(params: { readonly provider?: string | undefined; readonly label?: string | undefined }, context: CommandContext): CommandAnswer<{ account: AccountRecord }, Refused>;
  /** Internal only: the importer supplies a validated listed source. Cached identity does not claim current sign-in. */
  adoptDirectory(params: { readonly source: AccountDirectoryObservation; readonly label?: string | undefined }, context: CommandContext): CommandAnswer<{ account: AccountRecord }, Refused>;
  add(params: { readonly provider?: string | undefined; readonly label: string; readonly nameByEmail?: boolean | undefined }, context: CommandContext): CommandAnswer<{ account: AccountRecord; signIn: SignInStart }, Refused>;
  relabel(params: { readonly accountId: string; readonly label: string; readonly onlyIfNameByEmail?: boolean | undefined }, context: CommandContext): CommandAnswer<{ account: AccountRecord }, Refused>;
  remove(
    params: { readonly accountId: string; readonly deleteDirectory?: boolean | undefined },
    context: CommandContext,
  ): CommandAnswer<{ accountId: string; directoryDeleted: boolean }, Refused>;
  /** Stops the fifteen-minute reads, and a running sign-in's process. */
  close(): void;
}

/** Read-only metadata for a listed import directory. It does not prove current authentication. */
export interface AccountDirectoryObservation {
  readonly provider: string;
  readonly directory: string;
  readonly present: boolean;
  readonly identity: AccountIdentity | null;
  readonly detail: string | null;
  readonly checkedAt: string;
}

/** What a status read found. */
interface Observed {
  readonly state: AccountStatusState;
  readonly identity: AccountIdentity | null;
  readonly detail: string | null;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Settles as `work` does, or rejects once `ms` have passed on the wall clock (never the environment's, which a test may hold still). */
export const withTimeout = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number, what: string, controller = new AbortController()): Promise<T> =>
  new Promise<T>((resolvePromise, reject) => {
    const signal = controller.signal;
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => controller.abort(new ProbeTimeoutError(`${what} gave no answer within ${ms} ms.`)), ms);
    timer.unref();
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); signal.removeEventListener("abort", finish); };
    if (signal.aborted) { finish(); reject(signal.reason); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }).then(
      (value) => { finish(); resolvePromise(value); },
      (error: unknown) => { finish(); reject(error); },
    );
    signal.addEventListener("abort", finish, { once: true });
  });

/** A sign-in state as the store reads it: unreadable when the read said why it failed, signed in, expired when the provider says so, else signed out. */
const classify = (provider: string, status: AuthStatus): Observed => {
  if (status.error !== null) return { state: "unreadable", identity: null, detail: status.error };
  if (status.signedIn) {
    const identity = status.email === null ? null : { provider, email: status.email, organisation: status.orgName };
    return { state: "signed-in", identity, detail: null };
  }
  return { state: status.expired === true ? "expired" : "signed-out", identity: null, detail: null };
};

const describeIdentity = (identity: AccountIdentity): string => (identity.organisation === null ? identity.email : `${identity.email} (${identity.organisation})`);

/** The refusal of a sign-in another account already holds, by that account's label (setup-copy.md §5.1). */
const alreadyUsed = (holder: string): string => `This sign-in is already used by ${holder}.`;

/** Whether `path` is `root` or lies inside it. */
const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

const notFound = (aggregate: StreamRef, accountId: string) =>
  ({ aggregate, rejected: { code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } } }) as const;

const conflict = (aggregate: StreamRef, reason: string, message: string, data: Record<string, string> = {}) =>
  ({ aggregate, rejected: { code: "conflict", message, data: { reason, ...data } } }) as const;

export const createAccountService = (options: AccountServiceOptions): AccountService => {
  const { log, clock, environmentId } = options;
  const adapters: AdapterRegistry = createAdapterRegistry(options.adapters);
  const probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
  const defaults = options.defaults ?? (() => NO_DEFAULTS);
  const ownedRoot = options.ownedRoot === null ? null : resolve(options.ownedRoot);
  // The log's query-only read: inside a command it reads that command's own transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** When each account's status was last read, which the store keeps only when the state changed. */
  const checkedAt = new Map<string, string>();
  const catalogues = new Map<string, ModelCatalogue>();
  const timers = new Map<string, Timer>();
  const statusReads = new Map<string, Promise<void>>();
  const modelReads = new Map<string, Promise<void>>();
  const modelTimeouts = new Set<string>();
  const probes = new Set<AbortController>();
  const probeWork = async <T>(work: (signal: AbortSignal) => Promise<T>, what: string): Promise<T> => {
    const controller = new AbortController();
    probes.add(controller);
    try { return await withTimeout(work, probeTimeoutMs, what, controller); }
    finally { probes.delete(controller); }
  };
  /** The machine's own directory, by provider, as it was last read. */
  const ambient = new Map<string, AmbientProbe>();
  /** Why an owned account's sign-in was refused, for the director to say. */
  const refusals = new Map<string, string>();
  let closed = false;

  const withChecked = (record: AccountRecord): AccountRecord => {
    const at = checkedAt.get(record.id);
    return at === undefined ? record : { ...record, status: { ...record.status, checkedAt: at } };
  };

  const refOf = (record: AccountRecord): AccountRef => ({ id: record.id, directory: record.directory.path });

  /** The adapter `provider` names, else the first; `invalid_params` for a provider no adapter serves. */
  const adapterFor = (provider: string | undefined): Adapter => {
    const adapter = provider === undefined ? adapters.list()[0] : adapters.get(provider);
    if (adapter === undefined) {
      const message = provider === undefined ? "No provider is served on this environment." : `No adapter serves the provider ${provider} on this environment.`;
      throw new ContractError(invalidParams([{ code: "custom", path: ["provider"], message }], message));
    }
    return adapter;
  };

  const notice = (accountId: string, change: AccountChange, warning: string | null = null): void => {
    if (closed) return;
    const payload: AccountUpdatedPayload = { accountId, change, warning };
    try {
      log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "account.updated", payload }], { actor: ACCOUNT_STORE_ACTOR });
    } catch (error) {
      console.error(`Noticing the change to account ${accountId} failed:`, error);
    }
  };

  /** The directories nothing may delete: every account's the environment holds, and each provider's own on this machine. */
  const directoriesInUse = (): string[] => [
    ...listAccounts(reader).map((record) => resolve(record.directory.path)),
    ...adapters.list().flatMap((adapter) => {
      const own = adapter.ambientDirectory?.() ?? null;
      return own === null ? [] : [resolve(own)];
    }),
  ];

  /**
   * Removes an owned directory, and only one under the owned root that no
   * held account or provider's own directory is, holds or lies inside:
   * never the machine's own, never anything outside the data directory.
   * Run once the removal has committed, so the account it was is no longer held.
   */
  const deleteOwned = (path: string): void => {
    const target = resolve(path);
    if (ownedRoot === null || !within(target, ownedRoot) || target === ownedRoot) {
      console.error(`REFUSING TO DELETE ${target}: it is not under the environment's own account directories.`);
      return;
    }
    const used = directoriesInUse().find((directory) => within(directory, target) || within(target, directory));
    if (used !== undefined) {
      console.error(`REFUSING TO DELETE ${target}: ${used} is an account's directory or the machine's own provider directory.`);
      return;
    }
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      console.error(`DELETING THE ACCOUNT DIRECTORY ${target} FAILED; the next start removes it:`, error);
    }
  };

  const forget = (accountId: string): void => {
    timers.get(accountId)?.cancel();
    timers.delete(accountId);
    catalogues.delete(accountId);
    modelTimeouts.delete(accountId);
    checkedAt.delete(accountId);
  };

  const readModels = (accountId: string): Promise<void> => {
    if (closed) return Promise.resolve();
    const running = modelReads.get(accountId);
    if (running !== undefined) return running;
    const reading = (async () => {
      const record = liveAccount(reader, accountId);
      const adapter = record === null ? undefined : adapters.get(record.provider);
      if (record === null || adapter === undefined) return;
      try {
        const catalogue = await probeWork((signal) => adapter.models(refOf(record), signal), `The model listing of the account ${record.label}`);
        if (!closed && liveAccount(reader, accountId) !== null) {
          catalogues.set(accountId, catalogue);
          modelTimeouts.delete(accountId);
        }
      } catch (error) {
        if (closed) return;
        if (error instanceof ProbeTimeoutError) modelTimeouts.add(accountId);
        console.error(`Reading the models of the account ${record.label} failed: ${messageOf(error)}`);
      }
    })().finally(() => {
      modelReads.delete(accountId);
      arm(accountId);
    });
    modelReads.set(accountId, reading);
    return reading;
  };

  /**
   * Records what a status read found, in one transaction: the refusal of an
   * owned account's first identity that another account holds, else a new
   * identity (unless another account holds it, which is only warned of) and
   * a change of state. Answers what a notice should say, or null for no change.
   */
  const recordObserved = (accountId: string, observed: Observed): { change: AccountChange; warning: string | null } | null =>
    log.atomically((tx) => {
      const stored = readAccount(reader, accountId);
      if (stored === null || stored.removed) return null;
      const current = stored.record;
      const events: EventInput[] = [];
      let change: AccountChange | null = null;
      let warning: string | null = null;
      const identity = observed.identity;
      if (identity !== null && !sameIdentity(identity, current.identity)) {
        const holder = accountByIdentity(reader, identity);
        // Never signed in until this read, by the store's record rather than its current status, which a lapse resets.
        const firstSignIn = current.directory.kind === "owned" && current.identity === null && !stored.everSignedIn;
        if (holder !== null && holder.id !== accountId && firstSignIn) {
          // The sign-in's refusal (ADR 0018): one identity is one account, so the new account goes with its directory. An
          // account that has been signed in may have run, and its directory hold history: it is only warned of, below.
          warning = `The sign-in of ${current.label} yielded ${describeIdentity(identity)}, which is already added as ${holder.label}; ${current.label} was removed and its directory deleted.`;
          refusals.set(accountId, alreadyUsed(holder.label));
          log.append(
            accountStream(accountId),
            [
              { type: "account.removed", payload: { accountId, reason: "duplicate-identity" } },
              { type: "account.directory-deleted", payload: { accountId, directory: current.directory.path } },
            ],
            { actor: ACCOUNT_STORE_ACTOR, tx },
          );
          dropAccountInjection(log, environmentId, accountId, { actor: ACCOUNT_STORE_ACTOR, tx });
          tx.afterCommit(() => {
            forget(accountId);
            deleteOwned(current.directory.path);
          });
          return { change: "removed", warning };
        }
        if (holder !== null && holder.id !== accountId) {
          warning = `${current.label} now reads as signed in as ${describeIdentity(identity)}, which is already added as ${holder.label}; its identity is left as it was.`;
          change = "identity-mismatch";
        } else {
          events.push({ type: "account.identity-set", payload: { accountId, identity } });
          change = "identity-set";
        }
      }
      if (observed.state !== current.status.state) {
        events.push({ type: "account.status-changed", payload: { accountId, status: observed.state, previous: current.status.state, detail: observed.detail } });
        change = "status-changed";
      }
      if (events.length > 0) log.append(accountStream(accountId), events, { actor: ACCOUNT_STORE_ACTOR, tx });
      return change === null ? null : { change, warning };
    });

  /** Reads again in thirty seconds after a deadline, otherwise in fifteen minutes. */
  const arm = (accountId: string): void => {
    timers.get(accountId)?.cancel();
    if (closed || liveAccount(reader, accountId) === null) {
      timers.delete(accountId);
      return;
    }
    timers.set(
      accountId,
      clock.setTimeout(() => {
        void readStatus(accountId);
        // A catalogue a failed read left unknown is read again too, so the account is not left with no model to run.
        if (!catalogues.has(accountId) || modelTimeouts.has(accountId)) void readModels(accountId);
      }, liveAccount(reader, accountId)?.status.state === "unavailable" || modelTimeouts.has(accountId) ? PROBE_RETRY_INTERVAL_MS : STATUS_READ_INTERVAL_MS),
    );
  };

  /**
   * Reads an account's status through its adapter's probe, under the probe
   * timeout, and records what changed. Reads of one account are shared
   * while one is in flight; `fresh` waits for it and reads again, for a
   * caller that needs a read begun after it asked (a sign-in just done).
   */
  const readStatus = (accountId: string, how: { readonly quiet?: boolean; readonly fresh?: boolean } = {}): Promise<void> => {
    if (closed) return Promise.resolve();
    const running = statusReads.get(accountId);
    if (running !== undefined) return how.fresh === true ? running.then(() => readStatus(accountId, how)) : running;
    const reading = (async () => {
      const record = liveAccount(reader, accountId);
      if (record === null) return;
      const adapter = adapters.get(record.provider);
      let observed: Observed;
      if (adapter === undefined) observed = { state: "unreadable", identity: null, detail: `No adapter serves the provider ${record.provider} on this environment.` };
      else {
        try {
          observed = classify(record.provider, await probeWork((signal) => adapter.status(refOf(record), signal), `The status probe of the account ${record.label}`));
        } catch (error) {
          if (closed) return;
          const temporary = error instanceof ProbeTimeoutError;
          const detail = temporary ? `${messageOf(error)} Temporarily unavailable; automatic retry in ${PROBE_RETRY_INTERVAL_MS / 1000} seconds. No sign-in change was detected.` : messageOf(error);
          console.error(`Reading the status of the account ${record.label} failed: ${detail}`);
          observed = { state: temporary ? "unavailable" : "unreadable", identity: null, detail };
        }
      }
      if (closed) return;
      checkedAt.set(accountId, clock.now().toISOString());
      let noticed: ReturnType<typeof recordObserved>;
      try {
        noticed = recordObserved(accountId, observed);
      } catch (error) {
        console.error(`Recording the status of the account ${record.label} failed:`, error);
        return;
      }
      if (noticed !== null && how.quiet !== true) notice(accountId, noticed.change, noticed.warning);
    })().finally(() => {
      statusReads.delete(accountId);
      arm(accountId);
    });
    statusReads.set(accountId, reading);
    return reading;
  };

  const liveIds = (): string[] => listAccounts(reader).map((record) => record.id);

  /** The accounts a read names: the one given, which must be held, or every one. */
  const idsFor = (accountId: string | undefined): string[] => {
    if (accountId === undefined) return liveIds();
    if (liveAccount(reader, accountId) === null) {
      throw new ContractError({ code: "not_found", message: `No account ${accountId} is on this environment.`, data: { kind: "account", accountId } });
    }
    return [accountId];
  };

  const probe = async (provider?: string, quiet = false): Promise<AmbientProbe> => {
    const adapter = adapterFor(provider);
    const { provider: id, displayName } = adapter.descriptor;
    const own = adapter.ambientDirectory?.() ?? null;
    const directory = own === null ? null : resolve(own);
    let present = false;
    let signedIn = false;
    let identity: AccountIdentity | null = null;
    let detail: string | null = null;
    if (directory === null) detail = `The ${displayName} adapter has no directory of its own on this machine.`;
    else if (isDirectory(directory)) {
      // Only a directory that is there is read: a status read may create what it names.
      present = true;
      try {
        const observed = classify(id, await probeWork((signal) => adapter.status({ id: "ambient", directory }, signal), `The status probe of ${directory}`));
        signedIn = observed.state === "signed-in";
        identity = observed.identity;
        detail = observed.detail;
      } catch (error) {
        if (!quiet) console.error(`Reading the status of ${directory} failed:`, error);
        detail = messageOf(error);
      }
    }
    const reading: AmbientProbe = {
      provider: id,
      directory,
      present,
      signedIn,
      identity,
      accountId: directory === null ? null : (accountByDirectory(reader, directory)?.id ?? null),
      detail,
      checkedAt: clock.now().toISOString(),
    };
    ambient.set(id, reading);
    return reading;
  };

  /** The accounts #119 configured, adopted in place under their own ids, when the store has never held one. */
  const carryOver = (): void => {
    const configured = options.configured ?? [];
    if (configured.length === 0 || anyAccountEver(reader)) return;
    log.atomically((tx) => {
      for (const account of configured) {
        const adapter = adapters.get(account.provider);
        const directory = account.directory ?? adapter?.ambientDirectory?.() ?? null;
        const label = AccountLabel.safeParse(account.id);
        if (adapter === undefined || directory === null || !label.success) {
          console.error(`The configured account ${account.id} names no provider served here, no directory, or an id that is not a label; it is left out.`);
          continue;
        }
        // Read in this transaction: an id or a label (ignoring case) an earlier entry took leaves this one out, as the store's indexes would refuse it.
        if (readAccount(reader, account.id) !== null || accountByLabel(reader, label.data) !== null) {
          console.error(`The configured account ${account.id} repeats an id or a label another configured account has; it is left out.`);
          continue;
        }
        const payload = { accountId: account.id, provider: account.provider, label: label.data, directory: resolve(directory) };
        log.append(accountStream(account.id), [{ type: "account.adopted", payload }], { actor: ACCOUNT_STORE_ACTOR, tx });
      }
    });
  };

  /**
   * Removes what the owned root holds and no account should: an owned
   * directory whose deletion was recorded but not carried out, and a
   * directory named for no account the store ever held (an add that did not
   * commit). `deleteOwned` still keeps any that a held account or a
   * provider's own directory uses, whatever its name.
   */
  const sweepOwnedDirectories = (): void => {
    if (ownedRoot === null || !isDirectory(ownedRoot)) return;
    for (const entry of readdirSync(ownedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const account = readAccount(reader, entry.name);
      const leftOver = account === null || (account.record.directory.kind === "owned" && account.directoryDeleted);
      if (leftOver) deleteOwned(join(ownedRoot, entry.name));
    }
  };

  /** A new account's result: its record as the store holds it, read in the command's transaction. */
  const recordOf = (accountId: string): AccountRecord => {
    const record = liveAccount(reader, accountId);
    if (record === null) throw new Error(`The account ${accountId} is not in the store after a command applied to it.`);
    return withChecked(record);
  };

  const labelTaken = (aggregate: StreamRef, label: string, except?: string) => {
    const holder = accountByLabel(reader, label);
    if (holder === null || holder.id === except) return null;
    return conflict(aggregate, "label_taken", `Another account is already called ${label}. Choose another name.`, { accountId: holder.id });
  };

  const finished = async (accountId: string): Promise<SignInOutcome> => {
    if (liveAccount(reader, accountId) === null) return { signedIn: false, reason: "account_gone", message: `No account ${accountId} is on this environment.` };
    await readStatus(accountId, { fresh: true });
    const after = readAccount(reader, accountId);
    if (after === null || after.removed) {
      const refused = refusals.get(accountId);
      refusals.delete(accountId);
      return refused === undefined
        ? { signedIn: false, reason: "account_gone", message: `The account ${accountId} was removed.` }
        : { signedIn: false, reason: "identity_held", message: refused };
    }
    if (after.record.status.state !== "signed-in") {
      return { signedIn: false, reason: "not_signed_in", message: `${after.record.label} reads ${after.record.status.state} after its sign-in.` };
    }
    await readModels(accountId);
    return { signedIn: true, account: withChecked(after.record) };
  };
  const director: SignInDirector = (options.signIn ?? signInUnavailable)({ finished, account: (accountId) => liveAccount(reader, accountId) });

  /** Owning-service validation and events, shared by ambient and listed adoption inside the caller's transaction. */
  const adoptObserved = (
    source: AccountDirectoryObservation,
    labelGiven: string | undefined,
    context: CommandContext,
    accountId: string,
    ambientReading?: AmbientProbe,
  ): CommandAnswer<{ account: AccountRecord }, Refused> => {
    const aggregate = accountStream(accountId);
    const { provider, directory } = source;
    const holder = accountByDirectory(reader, directory) ?? (source.identity === null ? null : accountByIdentity(reader, source.identity));
    if (holder !== null) {
      return conflict(aggregate, "already_added", alreadyUsed(holder.label), { accountId: holder.id, directory });
    }
    const label = AccountLabel.safeParse(labelGiven ?? source.identity?.email);
    if (!label.success) return conflict(aggregate, "no_email", "This sign-in has no email to name the account by. Enter a name.", { directory });
    const taken = labelTaken(aggregate, label.data);
    if (taken !== null) return taken;
    const events: EventInput[] = [{ type: "account.adopted", payload: { accountId, provider, label: label.data, directory } }];
    if (source.identity !== null) events.push({ type: "account.identity-set", payload: { accountId, identity: source.identity } });
    if (ambientReading !== undefined) events.push({ type: "account.status-changed", payload: { accountId, status: "signed-in", previous: "signed-out", detail: null } });
    log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
    if (ambientReading !== undefined) checkedAt.set(accountId, source.checkedAt);
    context.tx.afterCommit(() => {
      if (ambientReading !== undefined) ambient.set(provider, { ...ambientReading, accountId });
      notice(accountId, "adopted");
      arm(accountId);
      // Listed adoption reads cached identity only. Normal refresh/startup owns authentication and model probes.
      if (ambientReading !== undefined) void readModels(accountId);
    });
    return { aggregate, result: { account: recordOf(accountId) } };
  };

  return {
    signIn: director,

    async start() {
      carryOver();
      sweepOwnedDirectories();
      await Promise.all(adapters.list().map((adapter) => probe(adapter.descriptor.provider, true)));
      await Promise.all(liveIds().map((id) => Promise.all([readStatus(id, { quiet: true }), readModels(id)])));
    },

    list: () => listAccounts(reader).map(withChecked),

    probe: (provider) => probe(provider),
    async observeDirectory({ provider, directory: given }) {
      const adapter = adapterFor(provider);
      const directory = resolve(given);
      const present = isDirectory(directory);
      let identity: AccountIdentity | null = null;
      let detail: string | null = null;
      if (!present) detail = "The import directory is not present.";
      else if (adapter.observeIdentity === undefined) detail = "The provider cannot observe a directory identity without probing credentials.";
      else {
        try {
          identity = await withTimeout(() => adapter.observeIdentity!(directory), probeTimeoutMs, "The directory identity read");
          if (identity !== null && identity.provider !== provider) throw new Error("The directory's cached identity names another provider.");
        } catch (error) { detail = messageOf(error); }
      }
      return { provider, directory, present, identity, detail, checkedAt: clock.now().toISOString() };
    },

    async refresh(accountId) {
      const ids = idsFor(accountId);
      await Promise.all(ids.map((id) => Promise.all([readStatus(id), readModels(id)])));
      return listAccounts(reader).map(withChecked);
    },

    async catalogues(accountId) {
      const ids = idsFor(accountId);
      await Promise.all(ids.filter((id) => !catalogues.has(id)).map(readModels));
      return ids.map((id): AccountCatalogue => {
        const catalogue = catalogues.get(id);
        return {
          accountId: id,
          live: catalogue?.live ?? false,
          models: (catalogue?.models ?? []).map((model) => ({ id: model.id, family: model.family, tier: model.tier, efforts: [...model.efforts], label: model.label ?? null, ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}) })),
        };
      });
    },

    adopt(params, context) {
      const adapter = adapterFor(params.provider);
      const { provider } = adapter.descriptor;
      const accountId = randomUUID();
      const aggregate = accountStream(accountId);
      const reading = ambient.get(provider);
      if (reading === undefined || reading.directory === null || !reading.present || !reading.signedIn) {
        // setup-copy.md §5.1: the line names no method and no path; the directory, where there is one, is the refusal's data.
        const line =
          reading === undefined
            ? `${PRODUCT_NAME} has not looked for Claude Code on this computer yet. Try again in a moment.`
            : reading.directory === null || !reading.present
              ? "Claude Code is not on this computer. Sign in with Claude instead."
              : "Claude Code on this computer is not signed in. Sign in with Claude instead.";
        return conflict(aggregate, "ambient_unavailable", line, reading === undefined || reading.directory === null ? {} : { directory: reading.directory });
      }
      return adoptObserved({ ...reading, directory: reading.directory }, params.label, context, accountId, reading);
    },

    adoptDirectory({ source, label }, context) {
      adapterFor(source.provider);
      const accountId = randomUUID();
      if (!source.present || !isDirectory(source.directory) || source.detail !== null || source.identity === null || source.identity.provider !== source.provider) {
        return conflict(accountStream(accountId), "source_unavailable", "The listed directory has no readable identity; plan it again before adopting it.");
      }
      return adoptObserved(source, label, context, accountId);
    },

    add(params, context) {
      const adapter = adapterFor(params.provider);
      const { provider } = adapter.descriptor;
      const accountId = randomUUID();
      const aggregate = accountStream(accountId);
      const taken = labelTaken(aggregate, params.label);
      if (taken !== null) return taken;
      if (ownedRoot === null) throw new Error("This environment has no data directory to make an account's directory in.");
      const directory = join(ownedRoot, accountId);
      const signIn = director.ready({ id: accountId, provider, label: params.label, directory: { kind: "owned", path: directory } });
      // Made before the command commits, so its receipt means the directory is there; an add that does not commit
      // leaves a directory the store never held, which the next start removes.
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") chmodSync(directory, 0o700);
      log.append(aggregate, [{ type: "account.added", payload: { accountId, provider, label: params.label, directory, ...(params.nameByEmail === true ? { nameByEmail: true } : {}) } }], {
        tx: context.tx,
        actor: context.actor,
        commandId: context.commandId,
      });
      const account = recordOf(accountId);
      context.tx.afterCommit(() => {
        notice(accountId, "added");
        arm(accountId);
        if (signIn.started) director.start(account);
      });
      return { aggregate, result: { account, signIn } };
    },

    relabel(params, context) {
      const { accountId, label } = params;
      const aggregate = accountStream(accountId);
      const current = liveAccount(reader, accountId);
      if (current === null) return notFound(aggregate, accountId);
      // Compare the naming choice inside the command transaction: a concurrent explicit rename wins.
      if ((params.onlyIfNameByEmail === true && current.nameByEmail !== true) || (current.label === label && current.nameByEmail !== true)) return { aggregate, result: { account: withChecked(current) } };
      const taken = labelTaken(aggregate, label, accountId);
      if (taken !== null) return taken;
      log.append(aggregate, [{ type: "account.relabelled", payload: { accountId, label, previous: current.label } }], {
        tx: context.tx,
        actor: context.actor,
        commandId: context.commandId,
      });
      context.tx.afterCommit(() => notice(accountId, "relabelled"));
      return { aggregate, result: { account: recordOf(accountId) } };
    },

    remove(params, context) {
      const { accountId } = params;
      const aggregate = accountStream(accountId);
      const current = liveAccount(reader, accountId);
      if (current === null) return notFound(aggregate, accountId);
      const deleteDirectory = params.deleteDirectory === true;
      if (deleteDirectory && current.directory.kind === "adopted") {
        return conflict(
          aggregate,
          "adopted_directory",
          `${current.label} is the machine's own provider directory, adopted in place; the environment never deletes it. Remove the account without deleting its directory.`,
          { accountId },
        );
      }
      const events: EventInput[] = [{ type: "account.removed", payload: { accountId, reason: "user" } }];
      if (deleteDirectory) events.push({ type: "account.directory-deleted", payload: { accountId, directory: current.directory.path } });
      log.append(aggregate, events, { tx: context.tx, actor: context.actor, commandId: context.commandId });
      dropAccountInjection(log, environmentId, accountId, context);
      context.tx.afterCommit(() => {
        forget(accountId);
        director.removed(accountId);
        if (deleteDirectory) deleteOwned(current.directory.path);
        notice(accountId, "removed");
      });
      return { aggregate, result: { accountId, directoryDeleted: deleteDirectory } };
    },

    facts(id) {
      const record = liveAccount(reader, id);
      const adapter = record === null ? undefined : adapters.get(record.provider);
      if (record === null || adapter === undefined) return null;
      return {
        id,
        directory: record.directory.path,
        label: record.label,
        adopted: record.directory.kind === "adopted",
        signedIn: record.status.state === "signed-in",
        identity: record.identity,
        descriptor: adapter.descriptor,
        models: catalogues.get(id)?.models ?? [],
      };
    },

    defaultId() {
      const chosen = defaults().account;
      if (chosen !== null && liveAccount(reader, chosen) !== null) return chosen;
      return liveIds()[0] ?? null;
    },

    defaults,

    providerOf: (id) => readAccount(reader, id)?.record.provider ?? null,

    crossCheck(accountId, identity, runId) {
      if (closed) return;
      const current = liveAccount(reader, accountId);
      if (current === null || current.identity === null || sameLogin(identity, current.identity)) return;
      notice(
        accountId,
        "identity-mismatch",
        `Run ${runId} on ${current.label} ran as ${describeIdentity(identity)}, not ${describeIdentity(current.identity)} as the account's status said; its status is read again.`,
      );
      readStatus(accountId, { fresh: true }).catch((error: unknown) => console.error(`Reading the status of the account ${current.label} again failed:`, error));
    },

    recheck(accountId) {
      if (closed) return;
      const current = liveAccount(reader, accountId);
      if (current === null) return;
      readStatus(accountId, { fresh: true }).catch((error: unknown) => console.error(`Reading the status of the account ${current.label} again failed:`, error));
    },

    close() {
      closed = true;
      for (const probe of probes) probe.abort(new Error("The account service closed."));
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
      director.close();
    },
  };
};
