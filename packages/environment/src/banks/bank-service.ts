import { existsSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  BANK_INDEX_BUDGET,
  BankName,
  ContractError,
  type BankKeyManager,
  ENVIRONMENT_STREAM_KIND,
  normaliseRemote,
  type BankEntry,
  type BankIndexConflict,
  type BankLocation,
  type BankManifestStatus,
  type BankRecord,
  type BankStatus,
  type ErrorOf,
  type ParamsOf,
} from "@agent-harness/contracts";
import { readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import { formatActor } from "../event-log/envelope.js";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import { createBankCommand } from "./create.js";
import type { ForgeOperations } from "../forge/operations.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, PreparedCommand, PreparedMethodHandler } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { runGit } from "../workspace/git.js";
import type { BankCredentials } from "./credentials.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex } from "./bank-index.js";
import { bankEver, importHolder, listBanks, liveBank, nameHolder } from "./bank-store.js";
import { renderFixedTiers } from "./index-renderer.js";

/**
 * The BankService's registry part (banks spec, "The registry" and "The
 * BankService's methods"; ADR 0010, ADR 0035, ADR 0036; #1025): it
 * registers an existing checkout, verifies every enabled bank, and answers
 * the records with their status, counts and rendered bank line. A bank's
 * files are read as committed at its checkout's head (`bank-files.ts`),
 * never as the working tree holds them.
 *
 * Verification reads what holds now: the remote's repository through the
 * ForgeService by the bank's origin, or a local-only bank's repository on
 * disk; `BANK.md` on main against the validator, or an open pull request
 * from a describe branch holding it; the orientation memories it names; and
 * a team bank's owners on its forge. Each part of the status keeps when it
 * last changed, and `bank.verified` is appended, as `system:banks`, only
 * when a part changed. A verification of every bank running is joined.
 */

export const BANKS_ACTOR = formatActor({ kind: "system", id: "banks" });

/** What the purpose of the BankService's forge reads is called, for a missing origin's record. */
const VERIFY_PURPOSE = "verify a memory bank";

/** The describe sessions' branches (`banks/describe.ts`), whose open pull requests hold a `BANK.md` awaiting review. */
const DESCRIBE_BRANCHES = "refs/heads/setup/describe-*";

/** What the BankService reads a bank's checkout as: its files, and its index when `BANK.md` names its kind. */
interface Reading {
  readonly files: BankFiles;
  readonly index: BankIndex | null;
}

/** What a bank's files say of it, read from `BANK.md`'s frontmatter; empty where it does not parse. */
interface Manifest {
  readonly name: string | null;
  readonly kind: "personal" | "team" | null;
  readonly orientation: readonly string[];
  readonly owners: readonly string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((each): each is string => typeof each === "string") : []);

const manifestOf = (files: BankFiles): Manifest => {
  const text = files["BANK.md"];
  const read = text === undefined ? null : readBankMarkdown(text);
  const data: Readonly<Record<string, unknown>> = read?.ok === true ? read.data : {};
  const kind = data.kind === "personal" || data.kind === "team" ? data.kind : null;
  return { name: typeof data.name === "string" ? data.name : null, kind, orientation: strings(data.orientation), owners: strings(data.owners) };
};

/** The bank's files at its checkout's head, and its index; null when git cannot read them, with why. */
const readCheckout = async (checkout: string, entry: Pick<BankEntry, "name" | "role">): Promise<{ readonly reading: Reading } | { readonly problem: string }> => {
  try {
    return { reading: readingFrom(await readBankFiles(checkout), entry) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
};

/** The bank's files as the registry names it: its index under its name and role, when its BANK.md names its kind. */
const readingFrom = (files: BankFiles, entry: Pick<BankEntry, "name" | "role">): Reading => {
  const { kind } = manifestOf(files);
  return { files, index: kind === null ? null : indexBank({ name: entry.name, kind, role: entry.role, files }) };
};

/** Where the checkout's `origin` remote points, as a bank's location: local when it has none, or one that names no forge repository. */
const locationOf = async (checkout: string): Promise<BankLocation> => {
  const remote = await runGit(checkout, ["remote", "get-url", "origin"], { maxBytes: 64 * 1024 });
  const found = remote.ok ? normaliseRemote(remote.stdout.toString("utf8").trim()) : null;
  return found === null || found.path === null ? { kind: "local" } : { kind: "remote", origin: found.origin, repository: found.path };
};

/** A status part as a comparison reads it: without when it began. */
const withoutSinceOf = (part: object): object => Object.fromEntries(Object.entries(part).filter(([key]) => key !== "since"));

/** `found`, each part keeping the since of `held`'s when it is unchanged. */
const keepSince = (held: BankStatus, found: BankStatus): BankStatus => {
  const same = (a: object, b: object): boolean => JSON.stringify(withoutSinceOf(a)) === JSON.stringify(withoutSinceOf(b));
  const pick = <T extends { readonly since: string }>(was: T, now: T): T => (same(was, now) ? was : now);
  return {
    reachable: pick(held.reachable, found.reachable),
    manifest: pick(held.manifest, found.manifest),
    orientation: pick(held.orientation, found.orientation),
    owners: pick(held.owners, found.owners),
    lastSync: held.lastSync,
    landing: held.landing,
  };
};


/** The entity aliases a bank's BANK.md claims, in lower case, by its name. */
interface Claim {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlySet<string>;
}

const claimOf = (entry: BankEntry, reading: Reading | null): Claim => ({
  id: entry.id,
  name: entry.name,
  aliases: new Set(reading?.index?.entities.flatMap((entity) => entity.aliases.map((alias) => alias.toLowerCase())) ?? []),
});

/**
 * The aliases `own` claims that another bank claims too (banks spec, "The
 * validator": a warning the BankService gives, which sees both banks): each
 * with the other banks, by name. A write is never routed by an alias, so
 * nothing else changes.
 */
const sharedAliases = (own: Claim, claims: readonly Claim[]): BankRecord["sharedAliases"] =>
  [...own.aliases].sort().flatMap((alias) => {
    const banks = claims.filter((other) => other.id !== own.id && other.aliases.has(alias)).map((other) => other.name);
    return banks.length === 0 ? [] : [{ alias, banks }];
  });

/** A bank as the 8 KB rule weighs it: its scopes and its fixed tiers' bytes. */
interface Weighed {
  readonly name: string;
  readonly accounts: BankEntry["accounts"];
  readonly repositories: BankEntry["repositories"];
  readonly bytes: number;
}

/** Whether `scope` (an account or `all`, a list or `all`) is in the bank's: `all` stands for every one no bank names. */
const covers = (held: "all" | readonly string[], one: string): boolean => held === "all" || (one !== "all" && held.includes(one));

/**
 * The 8 KB rule (banks spec, "The registry"; ADR 0013): where, with `added`
 * among `banks`, an account and a repository would carry more than 8 KB of
 * fixed tiers, the banks that would and the scopes; null where none would.
 * Every account and repository a bank names is weighed, and `all` for those
 * none names.
 */
const overLimit = (banks: readonly Weighed[], added: Weighed): Omit<BankIndexConflict, "reason"> | null => {
  const all = [...banks, added];
  const named = (pick: (bank: Weighed) => "all" | readonly string[]): string[] => ["all", ...new Set(all.flatMap((bank) => (pick(bank) === "all" ? [] : (pick(bank) as readonly string[]))))];
  const scopes: BankIndexConflict["scopes"] = [];
  const over = new Set<string>();
  let bytes = 0;
  for (const account of named((bank) => bank.accounts)) {
    for (const repository of named((bank) => bank.repositories)) {
      if (!covers(added.accounts, account) || !covers(added.repositories, repository)) continue;
      const inScope = all.filter((bank) => covers(bank.accounts, account) && covers(bank.repositories, repository));
      const total = inScope.reduce((sum, bank) => sum + bank.bytes, 0);
      if (total <= BANK_INDEX_BUDGET.fixedBytes) continue;
      if (scopes.length === 0) bytes = total;
      scopes.push({ account, repository });
      for (const bank of inScope) over.add(bank.name);
    }
  }
  if (scopes.length === 0) return null;
  return { bytes, limitBytes: BANK_INDEX_BUDGET.fixedBytes, banks: all.map((bank) => bank.name).filter((name) => over.has(name)), scopes };
};

/** Where the fixed tiers come past the limit, as a sentence names it. */
const scopeWords = ({ account, repository }: BankIndexConflict["scopes"][number]): string =>
  `${account === "all" ? "every account" : `the account ${account}`} in ${repository === "all" ? "every repository" : repository}`;

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export interface BankServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  /** The ForgeService's reads, which a remote bank's verification takes by its origin. */
  readonly forge: Pick<ForgeOperations, "repositories" | "pullRequests" | "users">;
  readonly credentials: BankCredentials;
  readonly creation?: {
    readonly dataDir: string;
    readonly localPersonName: string;
    readonly scrub: Pick<ScrubRegistry, "check">;
    readonly forge: Pick<ForgeService, "list" | "owners" | "repositories" | "git">;
    readonly accounts: () => readonly { readonly id: string }[];
    readonly keyManager: () => BankKeyManager | null;
  };
}

export interface BankService {
  /** Every bank registered now, with its status, counts and line. */
  list(): Promise<BankRecord[]>;
  /** The bank `bankId`; null for one not registered. */
  get(bankId: string): Promise<BankRecord | null>;
  /** Every bank registered now as the read model holds it, with what its last reading found: no read of a checkout. */
  entries(): readonly { readonly entry: BankEntry; readonly index: BankIndex | null }[];
  /** Verifies one bank, or every enabled one, joining a verification of every one running; answers the records after. */
  verify(bankId?: string): Promise<BankRecord[]>;
  /** Records a fetch outcome and refreshes the cached reading; only a moved head emits bank.synced. */
  recordSync(bankId: string, outcome: { readonly head: string; readonly previousHead: string | null } | { readonly problem: string }): Promise<void>;
  readonly register: PreparedCommand<"banks.register">;
  readonly git: BankCredentials["git"];
  readonly create: PreparedCommand<"banks.create">;
}

export const createBankService = (options: BankServiceOptions): BankService => {
  const { log, clock, forge } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  // What each bank's checkout read as when last read: its counts, line, entities and scopes come from here.
  const readings = new Map<string, Reading | null>();
  let verifyingAll: Promise<BankRecord[]> | null = null;
  const verificationGenerations = new Map<string, number>();

  /** The bank's record from its entry and reading, its shared aliases those `others` claim too. */
  const recordOf = (entry: BankEntry, reading: Reading | null, others: readonly Claim[]): BankRecord => {
    const index = reading?.index ?? null;
    const line = index === null ? null : (renderFixedTiers(index).text.split("\n")[0] ?? null);
    return { ...entry, memories: index?.count ?? 0, folders: index?.folderCount ?? 0, line, sharedAliases: sharedAliases(claimOf(entry, reading), others) };
  };

  /** The reading held of the bank, read now when none is. */
  const readingOf = async (entry: BankEntry): Promise<Reading | null> => {
    if (readings.has(entry.id)) return readings.get(entry.id) ?? null;
    const read = await readCheckout(entry.checkout, entry);
    const reading = "reading" in read ? read.reading : null;
    readings.set(entry.id, reading);
    return reading;
  };

  /** Every bank registered now with its reading, read where none is held. */
  const readAll = async (): Promise<{ readonly entry: BankEntry; readonly reading: Reading | null }[]> =>
    Promise.all(listBanks(reader).map(async (entry) => ({ entry, reading: await readingOf(entry) })));

  /** Every bank registered now as the methods answer it. */
  const records = async (): Promise<BankRecord[]> => {
    const read = await readAll();
    const claims = read.map(({ entry, reading }) => claimOf(entry, reading));
    return read.map(({ entry, reading }) => recordOf(entry, reading, claims));
  };

  /** Whether the remote answers for the repository, or why not. */
  const reachableRemote = async (location: Extract<BankLocation, { kind: "remote" }>): Promise<string | null> => {
    const answer = await forge.repositories.get({ origin: location.origin, repository: location.repository, purpose: VERIFY_PURPOSE });
    switch (answer.outcome) {
      case "done":
        return null;
      case "unreachable":
        return `${location.origin} did not answer: ${answer.message}`;
      case "failed":
        return answer.status === 404 ? `${location.origin} has no repository ${location.repository}` : `${location.origin} answered HTTP ${answer.status}: ${answer.message}`;
      case "refused":
        return answer.error.message;
    }
  };

  /**
   * The web address of an open pull request from a describe branch whose head holds `BANK.md`, null for none, and
   * whether the forge answered for every such branch: one it did not answer for may hold one.
   */
  const manifestAwaitingReview = async (checkout: string, location: BankLocation): Promise<{ readonly pullRequest: string | null; readonly answered: boolean }> => {
    if (location.kind !== "remote") return { pullRequest: null, answered: true };
    const listing = await runGit(checkout, ["for-each-ref", "--sort=-refname", "--format=%(refname:short)", DESCRIBE_BRANCHES], { maxBytes: 64 * 1024 });
    const branches = listing.ok ? listing.stdout.toString("utf8").split("\n").filter((branch) => branch !== "") : [];
    let answered = true;
    for (const branch of branches) {
      const holds = await runGit(checkout, ["cat-file", "-e", `${branch}:BANK.md`], { maxBytes: 1024 });
      if (!holds.ok) continue;
      const answer = await forge.pullRequests.listByHead({ origin: location.origin, repository: location.repository, branch, limit: 5, purpose: VERIFY_PURPOSE });
      if (answer.outcome !== "done") answered = false;
      const open = answer.outcome === "done" ? answer.value.find((pullRequest) => pullRequest.state === "open") : undefined;
      if (open !== undefined) return { pullRequest: open.url, answered };
    }
    return { pullRequest: null, answered };
  };

  /**
   * `BANK.md` on main: valid, missing or failing a rule, unless an open pull request holds one. A forge that does not
   * answer leaves a pull request last found holding one as found: it says nothing of whether that one is still open.
   */
  const manifestStatus = async (entry: Pick<BankEntry, "checkout" | "location" | "status">, files: BankFiles, since: string): Promise<BankManifestStatus> => {
    const refusal = files["BANK.md"] === undefined ? null : validateBank({ files }).findings.find((finding) => finding.severity === "refusal" && finding.path === "BANK.md");
    if (files["BANK.md"] !== undefined && refusal === undefined) return { state: "valid", since };
    const { pullRequest, answered } = await manifestAwaitingReview(entry.checkout, entry.location);
    if (pullRequest !== null) return { state: "awaiting-review", pullRequest, since };
    if (!answered && entry.status.manifest.state === "awaiting-review") return entry.status.manifest;
    if (refusal === null || refusal === undefined) return { state: "missing", since };
    return { state: "invalid", rule: refusal.rule, message: refusal.message, since };
  };

  /**
   * A team bank's owners its forge has no user for: a 404. An owner the forge does not answer for stays as `held`
   * last found it, unresolved or not, since the forge said nothing of it.
   */
  const unresolvedOwners = async (location: BankLocation, manifest: Manifest, held: readonly string[]): Promise<string[]> => {
    if (manifest.kind !== "team" || location.kind !== "remote") return [];
    const unresolved: string[] = [];
    for (const login of manifest.owners) {
      const answer = await forge.users.get({ origin: location.origin, login, purpose: VERIFY_PURPOSE });
      const missing = answer.outcome === "failed" && answer.status === 404;
      const unanswered = !missing && answer.outcome !== "done";
      if (missing || (unanswered && held.includes(login))) unresolved.push(login);
    }
    return unresolved;
  };

  /** What holds of the bank now: its status as found, every part since now, and its reading. */
  const inspect = async (entry: Pick<BankEntry, "name" | "role" | "checkout" | "location" | "status">): Promise<{ readonly status: BankStatus; readonly reading: Reading | null }> => {
    const since = clock.now().toISOString();
    const read = await readCheckout(entry.checkout, entry);
    const unreadable = "problem" in read ? (existsSync(entry.checkout) ? `its repository at ${entry.checkout} cannot be read: ${read.problem}` : `its repository at ${entry.checkout} is not there`) : null;
    // A checkout git cannot read fails the bank wherever its remote is; a readable one with a remote fails when its forge does not have it.
    const unreachable = unreadable ?? (entry.location.kind === "remote" ? await reachableRemote(entry.location) : null);
    const reachable: BankStatus["reachable"] = unreachable === null ? { state: "reachable", since } : { state: "unreachable", reason: unreachable, since };
    // A checkout that cannot be read says nothing new of what it holds: those parts stay as last found.
    if ("problem" in read) return { status: { ...entry.status, reachable }, reading: null };
    const { reading } = read;
    const manifest = manifestOf(reading.files);
    const present = new Set(reading.index?.orientation.map((memory) => memory.name) ?? []);
    const status: BankStatus = {
      reachable,
      manifest: await manifestStatus(entry, reading.files, since),
      orientation: { missing: manifest.orientation.filter((name) => !present.has(name)), since },
      owners: { unresolved: await unresolvedOwners(entry.location, manifest, entry.status.owners.unresolved), since },
      lastSync: entry.status.lastSync,
      landing: entry.status.landing,
    };
    return { status, reading };
  };

  /** Verifies one bank and records what changed; answers its entry after. */
  const verifyOne = async (entry: BankEntry): Promise<void> => {
    const generation = (verificationGenerations.get(entry.id) ?? 0) + 1;
    verificationGenerations.set(entry.id, generation);
    const { status: found, reading } = await inspect(entry);
    // A newer inspection (notably a sync) owns the reading: an older one must never put old files back.
    if (verificationGenerations.get(entry.id) !== generation) return;
    const manifest = reading === null ? null : manifestOf(reading.files);
    log.atomically((tx) => {
      const held = liveBank(reader, entry.id);
      if (held === null) return;
      // A name or kind BANK.md names since the bank was registered is the record's, a name another bank holds aside.
      const named = BankName.safeParse(manifest?.name);
      const name = named.success && named.data !== held.name && nameHolder(reader, named.data) === null ? named.data : undefined;
      const kind = manifest?.kind != null && manifest.kind !== held.kind ? manifest.kind : undefined;
      if (name !== undefined || kind !== undefined) {
        log.append(stream, [{ type: "bank.updated", payload: { bankId: entry.id, ...(name !== undefined && { name }), ...(kind !== undefined && { kind }) } }], { tx, actor: BANKS_ACTOR });
      }
      const status = keepSince(held.status, found);
      if (JSON.stringify(status) === JSON.stringify(held.status)) return;
      log.append(stream, [{ type: "bank.verified", payload: { bankId: entry.id, status } }], { tx, actor: BANKS_ACTOR });
    });
    const now = liveBank(reader, entry.id);
    readings.set(entry.id, reading === null || now === null ? reading : readingFrom(reading.files, now));
  };

  const verifyAll = (): Promise<BankRecord[]> => {
    verifyingAll ??= (async () => {
      try {
        for (const entry of listBanks(reader).filter((bank) => bank.enabled)) await verifyOne(entry);
        return await records();
      } finally {
        verifyingAll = null;
      }
    })();
    return verifyingAll;
  };

  const prepareRegister = async (params: ParamsOf<"banks.register">, personalDefaults = false): Promise<PreparedMethodHandler<"banks.register">> => {
    const rejecting =
      (rejected: CommandRejection<ErrorOf<"banks.register">["code"]>): PreparedMethodHandler<"banks.register"> =>
      () => ({ aggregate: stream, rejected });
    const imported = params.importedFrom === undefined ? null : importHolder(reader, params.importedFrom);
    if (imported !== null) {
      const answer = (await records()).find((bank) => bank.id === imported) ?? null;
      return () => (answer === null ? { aggregate: stream, rejected: { code: "not_found" } } : { aggregate: stream, result: { bank: answer } });
    }
    if (!isAbsolute(params.path)) return rejecting({ code: "invalid_params", message: `The path ${params.path} is not absolute: name the checkout from the root.`, data: { issues: [] } });
    const read = await readCheckout(params.path, { name: "unnamed", role: params.role });
    if ("problem" in read) return rejecting({ code: "invalid_params", message: `The path ${params.path} holds no git repository a bank can be read from: ${read.problem}`, data: { issues: [] } });
    const manifest = manifestOf(read.reading.files);
    const named = BankName.safeParse(manifest.name ?? basename(params.path).toLowerCase());
    if (!named.success) {
      return rejecting({ code: "invalid_params", message: `The bank at ${params.path} has no name: its BANK.md names none, and its folder's name is no bank name.`, data: { issues: [] } });
    }
    const location = await locationOf(params.path);
    const draft = entryOf(params, named.data, manifest, location, clock.now().toISOString());
    const { status, reading } = await inspect(draft);
    const preparedEntry: BankEntry = { ...draft, status };
    const held = await readAll();
    const claims = held.map(({ entry: bank, reading: its }) => claimOf(bank, its));
    return (_params, command) => {
      const assigned = new Set(listBanks(reader).flatMap((bank) => bank.defaultFor));
      const entry = { ...preparedEntry, ...(personalDefaults && { defaultFor: (options.creation?.accounts() ?? []).map((account) => account.id).filter((id) => !assigned.has(id)) }) };
      if (bankEver(reader, entry.id)) {
        return { aggregate: stream, rejected: { code: "conflict", message: `A bank ${entry.id} was registered on this environment already.`, data: { reason: "exists", bankId: entry.id } } };
      }
      if (nameHolder(reader, entry.name) !== null) {
        return { aggregate: stream, rejected: { code: "conflict", message: `Another bank is named ${entry.name}.`, data: { reason: "name_taken", name: entry.name } } };
      }
      // Weighed against the banks registered now, as the name is: one registered or forgotten while this one was read counts.
      const weighed = listBanks(reader)
        .filter((bank) => bank.enabled)
        .map((bank): Weighed => ({ ...bank, bytes: fixedBytes(readings.get(bank.id) ?? null) }));
      const conflict = overLimit(weighed, { ...entry, bytes: fixedBytes(reading) });
      if (conflict !== null) {
        const [first] = conflict.scopes;
        const message = `The fixed tiers of ${listed(conflict.banks)} would come to ${conflict.bytes} bytes for ${first === undefined ? "a scope" : scopeWords(first)}, over the ${conflict.limitBytes}-byte limit.`;
        return { aggregate: stream, rejected: { code: "conflict", message, data: { reason: "index_too_large", ...conflict } } };
      }
      command.tx.afterCommit(() => readings.set(entry.id, reading));
      log.append(stream, [{ type: "bank.added", payload: { bank: entry } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { bank: recordOf(entry, reading, claims) } };
    };
  };
  const register: BankService["register"] = { prepare: (params) => prepareRegister(params) };
  const create: BankService["create"] = options.creation === undefined ? {
    prepare: () => { throw new ContractError({ code: "not_found", message: "Bank creation is unavailable on this service.", data: {} }); },
  } : createBankCommand({
    ...options.creation,
    register: prepareRegister,
    async admit(bankId, name, files) {
      await readAll();
      if (bankEver(reader, bankId)) throw new ContractError({ code: "conflict", message: `A bank ${bankId} was registered already.`, data: { reason: "exists", bankId } });
      if (nameHolder(reader, name) !== null) throw new ContractError({ code: "conflict", message: `Another bank is named ${name}.`, data: { reason: "name_taken", name } });
      const weighed = listBanks(reader).filter((bank) => bank.enabled).map((bank): Weighed => ({ ...bank, bytes: fixedBytes(readings.get(bank.id) ?? null) }));
      const conflict = overLimit(weighed, { name, accounts: "all", repositories: "all", bytes: fixedBytes(readingFrom(files, { name, role: "read-write" })) });
      if (conflict !== null) throw new ContractError({ code: "conflict", message: "The bank would exceed the fixed-tier limit.", data: { reason: "index_too_large", ...conflict } });
    },
  });

  return {
    git: options.credentials.git,
    list: records,
    get: async (bankId) => (await records()).find((bank) => bank.id === bankId) ?? null,
    entries: () => listBanks(reader).map((entry) => ({ entry, index: readings.get(entry.id)?.index ?? null })),
    async verify(bankId) {
      if (bankId === undefined) return verifyAll();
      const entry = liveBank(reader, bankId);
      if (entry !== null) await verifyOne(entry);
      return records();
    },
    async recordSync(bankId, outcome) {
      const entry = liveBank(reader, bankId);
      if (entry === null) return;
      if ("head" in outcome) await verifyOne(entry);
      else verificationGenerations.set(bankId, (verificationGenerations.get(bankId) ?? 0) + 1);
      log.atomically((tx) => {
        const held = liveBank(reader, bankId);
        if (held === null) return;
        const now = clock.now().toISOString();
        const status: BankStatus = "head" in outcome
          ? { ...held.status, lastSync: now }
          : { ...held.status, reachable: held.status.reachable.state === "unreachable" && held.status.reachable.reason === outcome.problem
            ? held.status.reachable : { state: "unreachable", reason: outcome.problem, since: now } };
        const moved = "head" in outcome && outcome.previousHead !== null && outcome.head !== outcome.previousHead;
        if (moved) log.append(stream, [{ type: "bank.synced", payload: { bankId, head: outcome.head, previousHead: outcome.previousHead } }], { tx, actor: BANKS_ACTOR });
        if (moved || JSON.stringify(status) !== JSON.stringify(held.status)) {
          log.append(stream, [{ type: "bank.updated", payload: { bankId, status } }], { tx, actor: BANKS_ACTOR });
        }
      });
    },
    register,
    create,
  };
};

/** The bytes of a bank's fixed tiers (T0 to T2), which the 8 KB rule adds up; none for a bank whose BANK.md names no kind. */
const fixedBytes = (reading: Reading | null): number => (reading?.index == null ? 0 : renderFixedTiers(reading.index).bytes);

/** The entry a register makes, before its verification: the defaults a registered bank takes (ADR 0035). */
const entryOf = (params: ParamsOf<"banks.register">, name: string, manifest: Manifest, location: BankLocation, now: string): BankEntry => ({
  id: params.bankId,
  name,
  kind: manifest.kind,
  location,
  checkout: params.path,
  role: params.role,
  enabled: true,
  accounts: params.accounts,
  repositories: params.repositories,
  defaultFor: params.defaultFor,
  pins: [],
  mergeOverride: "none",
  privateCopy: false,
  credential: "forge",
  status: {
    reachable: { state: "reachable", since: now },
    manifest: { state: "missing", since: now },
    orientation: { missing: [], since: now },
    owners: { unresolved: [], since: now },
    lastSync: null,
    landing: { state: "ok", since: now },
  },
  importedFrom: params.importedFrom ?? null,
  copiedFrom: null,
  createdAt: now,
});
