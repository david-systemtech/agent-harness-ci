import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createBankLander, type BankChanges } from "./lander.js";
import { createDescribeLanding } from "./describe-landing.js";
import { describeRepositoryAt } from "./describe-repository.js";
import {
  BANK_INDEX_BUDGET,
  bankValidatorStatus,
  BankName,
  ContractError,
  type BankKeyManager,
  ENVIRONMENT_STREAM_KIND,
  normaliseRemote,
  parseBankPointer,
  type BankEntry,
  type BankIndexConflict,
  type BankLocation,
  type BankJoinPreview,
  type BankLandingStatus,
  type BankManifestStatus,
  type BankRecord,
  type BankDraft,
  type MemoryPromoteResult,
  type BankStatus,
  type ErrorOf,
  type ParamsOf,
} from "@agent-harness/contracts";
import { readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import { formatActor } from "../event-log/envelope.js";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import { coversOrigin, isForgeAccountMissingOn } from "../forge/missing-origins.js";
import { refusalReason } from "../forge/operations.js";
import { joinBank, previewBank } from "./join.js";
import { prepareBankPublication } from "./publish.js";
import { createBankCommand } from "./create.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import type { Clock } from "../serve/clock.js";
import type { CommandContext, CommandRejection, MethodHandler, PreparedCommand, PreparedMethodHandler } from "../serve/methods.js";
import { readSummary } from "../sessions/session-reads.js";
import type { Reader } from "../sessions/session-tables.js";
import { runGit } from "../workspace/git.js";
import type { BankCredentials } from "./credentials.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex } from "./bank-index.js";
import { bankEver, importHolder, listBanks, liveBank, nameHolder, sessionBankPins } from "./bank-store.js";
import { readPointer, renderFixedTiers } from "./index-renderer.js";

/**
 * The BankService's registry part (banks spec, "The registry" and "The
 * BankService's methods"; ADR 0010, ADR 0035, ADR 0036, ADR 0037; #1025, #1026): it
 * previews, joins, registers and updates banks, keeps session pins, forgets banks with
 * optional removal of its own checkout, verifies enabled banks, and answers
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

/** Retained refresh failures stay visible to Health until a successful sync. */
export const REGISTERED_SYNC_BLOCKED = "Sync paused for registered checkout";

/** What the purpose of the BankService's forge reads is called, for a missing origin's record. */
const VERIFY_PURPOSE = "verify a memory bank";

/** Why a verification could not reach a bank, and the cause the Memory bank step names, where it found one. */
type Unreachable = Omit<Extract<BankStatus["reachable"], { state: "unreachable" }>, "state" | "since">;

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

/**
 * The bank's held landing, unless it failed for want of a forge account on the bank's own origin and the bank now
 * reads reachable with a forge account here covering that origin: its cause is gone, so the failure and its advice to
 * add an account are cleared as of `since` (#1900). Any other failure holds until a landing passes.
 */
const settledLanding = ({ location, status: { landing } }: Pick<BankEntry, "location" | "status">, reachable: BankStatus["reachable"], covered: (origin: string) => boolean, since: string): BankLandingStatus =>
  landing.state === "failed" && location.kind === "remote" && reachable.state === "reachable" && isForgeAccountMissingOn(landing.reason, location.origin) && covered(location.origin)
    ? { state: "ok", since }
    : landing;


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

/** The refusal of a bank whose fixed tiers would come past the limit (setup-copy.md §5.8): the banks, bytes and scopes are in its data. */
const TOO_LONG_AT_START = "With this notebook, what agents read at the start would be too long. Turn another notebook off first.";

export interface BankServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  readonly dataDir: string;
  readonly scrub: Pick<ScrubRegistry, "check">;
  /** The ForgeService's reads, which a remote bank's verification takes by its origin, and its forge accounts. */
  readonly forge: Pick<ForgeService, "list" | "repositories" | "pullRequests" | "users" | "git">;
  readonly credentials: Pick<BankCredentials, "git">;
  readonly creation?: {
    readonly dataDir: string;
    readonly localPersonName: string;
    readonly scrub: Pick<ScrubRegistry, "check">;
    readonly forge: Pick<ForgeService, "list" | "owners" | "repositories" | "pullRequests" | "issues" | "git">;
    readonly accounts: () => readonly { readonly id: string }[];
    readonly keyManager: () => BankKeyManager | null;
  };
}

export interface BankService {
  /** Serializes sync and landing work that share a bank's checkout and git refs. */
  withCheckout<T>(bankId: string, work: () => Promise<T>): Promise<T>;
  /** Installs the environment-owned landing path once its session directories exist. */
  configureLanding(options: Pick<Parameters<typeof createBankLander>[0], "forge" | "scrub" | "temporaryDirectory">): void;
  closeLanding(): Promise<void>;
  promote(bankId: string, sessionId: string, drafts: readonly BankDraft[]): Promise<MemoryPromoteResult>;
  /** Trusted BankService callers submit non-draft changes here; remote changes always require review. */
  landChanges(bankId: string, changes: BankChanges): Promise<MemoryPromoteResult>;
  /** Reconciles a held review; expectedPaths refuses unrelated changes before any forge work. */
  reconcileLanding(bankId: string, expectedPaths?: readonly string[]): Promise<MemoryPromoteResult | null>;
  /** Every bank registered now, with its status, counts and line. */
  list(): Promise<BankRecord[]>;
  /** The bank `bankId`; null for one not registered. */
  get(bankId: string): Promise<BankRecord | null>;
  /** Every bank registered now as the read model holds it, with what its last reading found: no read of a checkout. */
  entries(): readonly { readonly entry: BankEntry; readonly index: BankIndex | null }[];
  /** Verifies one bank, or every enabled one, joining a verification of every one running; answers the records after. */
  verify(bankId?: string): Promise<BankRecord[]>;
  preview(url: string): Promise<BankJoinPreview>;
  /** Records a fetch outcome and refreshes the cached reading; only a moved head emits bank.synced. */
  recordSync(bankId: string, outcome: { readonly head: string; readonly previousHead: string | null } | { readonly problem: string }): Promise<void>;
  readonly register: PreparedCommand<"banks.register">;
  readonly update: PreparedCommand<"banks.registry.update">;
  readonly pin: PreparedCommand<"banks.pin">;
  readonly forget: PreparedCommand<"banks.forget">;
  /** This session's own pins for the BankLayer and renderer, separate from every entry's registry pins. */
  sessionPins(sessionId: string): readonly string[];
  readonly join: PreparedCommand<"banks.join">;
  readonly git: BankCredentials["git"];
  readonly create: PreparedCommand<"banks.create">;
  readonly publish: PreparedCommand<"banks.publish">;
}

export const createBankService = (options: BankServiceOptions): BankService => {
  const { log, clock, forge } = options;
  const checkoutWork = new Map<string, Promise<unknown>>();
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  recoverCheckoutRemovals(reader, log, stream, options.dataDir);
  // What each bank's checkout read as when last read: its counts, line, entities and scopes come from here.
  const readings = new Map<string, Reading | null>();
  let lander: ReturnType<typeof createBankLander> | undefined;
  const reconcileLanding = async (bankId: string, expectedPaths?: readonly string[]): Promise<MemoryPromoteResult | null> => {
    const bank = liveBank(reader, bankId);
    if (!lander || !bank) return null;
    return lander.reconcile(bank, expectedPaths);
  };
  let verifyingAll: Promise<BankRecord[]> | null = null;
  const verificationGenerations = new Map<string, number>();

  /** A chosen default replaces the old one for those accounts, in the same transaction. */
  const transferDefaults = (entry: BankEntry, command: CommandContext): void => {
    for (const bank of listBanks(reader)) {
      if (bank.id === entry.id) continue;
      const defaultFor = bank.defaultFor.filter((account) => !entry.defaultFor.includes(account));
      if (defaultFor.length === bank.defaultFor.length) continue;
      log.append(stream, [{ type: "bank.updated", payload: { bankId: bank.id, defaultFor } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
    }
  };

  /** Admission uses the renderer's fixed tiers, excluding the entry being replaced and disabled banks. */
  const admission = (entry: BankEntry, reading: Reading | null): CommandRejection<"conflict"> | null => {
    if (!entry.enabled) return null;
    const weighed = listBanks(reader).filter((bank) => bank.id !== entry.id && bank.enabled).map((bank): Weighed => ({ ...bank, bytes: fixedBytes(readings.get(bank.id) ?? null) }));
    const conflict = overLimit(weighed, { ...entry, bytes: fixedBytes(reading) });
    if (conflict === null) return null;
    return { code: "conflict", message: TOO_LONG_AT_START, data: { reason: "index_too_large", ...conflict } };
  };

  /** The bank's record from its entry and reading, its shared aliases those `others` claim too. */
  const recordOf = (entry: BankEntry, reading: Reading | null, others: readonly Claim[]): BankRecord => {
    const index = reading?.index ?? null;
    const line = index === null ? null : (renderFixedTiers(index).text.split("\n")[0] ?? null);
    return { ...entry, validator: bankValidatorStatus(reading?.files[".agent-harness/validate.mjs"]), memories: index?.count ?? 0, folders: index?.folderCount ?? 0, line, sharedAliases: sharedAliases(claimOf(entry, reading), others) };
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
  const reachableRemote = async (location: Extract<BankLocation, { kind: "remote" }>): Promise<Unreachable | null> => {
    const answer = await forge.repositories.get({ origin: location.origin, repository: location.repository, purpose: VERIFY_PURPOSE });
    switch (answer.outcome) {
      case "done":
        return null;
      case "unreachable":
        return { reason: `${location.origin} did not answer: ${answer.message}` };
      case "failed":
        return answer.status === 404
          ? { reason: `${location.origin} has no repository ${location.repository}`, cause: "repository-missing" }
          : { reason: `${location.origin} answered HTTP ${answer.status}: ${answer.message}` };
      case "refused":
        return { reason: refusalReason(answer.error), ...(answer.error.code === "forge_account_missing" && { cause: "no-forge-account" }) };
    }
  };

  /**
   * The web address of an open pull request from a describe branch whose head holds `BANK.md`, null for none, and
   * whether the forge answered for every such branch: one it did not answer for may hold one.
   */
  const manifestAwaitingReview = async (checkout: string, location: BankLocation): Promise<{ readonly pullRequest: string | null; readonly answered: boolean }> => {
    if (location.kind !== "remote") return { pullRequest: null, answered: true };
    let answered = true;
    const describe = describeRepositoryAt(options.dataDir, checkout);
    for (const repository of [checkout, describe]) {
      const listing = await runGit(repository, ["for-each-ref", "--sort=-refname", "--format=%(refname:short)", DESCRIBE_BRANCHES], { maxBytes: 64 * 1024 });
      const branches = listing.ok ? listing.stdout.toString("utf8").split("\n").filter((branch) => branch !== "") : [];
      for (const branch of branches) {
        const holds = await runGit(repository, ["cat-file", "-e", `${branch}:BANK.md`], { maxBytes: 1024 });
        if (!holds.ok) continue;
        try { if (!validateBank({ files: await readBankFiles(repository, branch) }).valid) continue; } catch { continue; }
        const head = await runGit(repository, ["rev-parse", branch], { maxBytes: 1024 });
        if (!head.ok || head.truncated) continue;
        const sha = head.stdout.toString("utf8").trim();
        const answer = await forge.pullRequests.listByHead({ origin: location.origin, repository: location.repository, branch, limit: 5, purpose: VERIFY_PURPOSE });
        if (answer.outcome !== "done") answered = false;
        const open = answer.outcome === "done" ? answer.value.find((pullRequest) => pullRequest.state === "open" && pullRequest.head.sha === sha && pullRequest.base.ref === "main") : undefined;
        if (open !== undefined) return { pullRequest: open.url, answered };
      }
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
  const inspect = async (entry: Pick<BankEntry, "name" | "role" | "checkout" | "location" | "status" | "checkoutOwnership">): Promise<{ readonly status: BankStatus; readonly reading: Reading | null }> => {
    const since = clock.now().toISOString();
    const read = await readCheckout(entry.checkout, entry);
    const unreadable: Unreachable | null = "problem" in read
      ? (existsSync(entry.checkout) ? { reason: `its repository at ${entry.checkout} cannot be read: ${read.problem}` } : { reason: `its repository at ${entry.checkout} is not there`, cause: "folder-missing" })
      : null;
    // A checkout git cannot read fails the bank wherever its remote is; a readable one with a remote fails when its forge does not have it.
    const syncProblem = entry.checkoutOwnership !== "managed" && entry.status.reachable.state === "unreachable" && entry.status.reachable.reason.startsWith(REGISTERED_SYNC_BLOCKED)
      ? { reason: entry.status.reachable.reason } : null;
    const unreachable = unreadable ?? (entry.location.kind === "remote" ? await reachableRemote(entry.location) : null) ?? syncProblem;
    const reachable: BankStatus["reachable"] = unreachable === null ? { state: "reachable", since } : { state: "unreachable", ...unreachable, since };
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
    entry = liveBank(reader, entry.id) ?? entry;
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
      const kept = keepSince(held.status, found);
      const status: BankStatus = { ...kept, landing: settledLanding(held, kept.reachable, (origin) => coversOrigin(forge.list(), origin), clock.now().toISOString()) };
      if (JSON.stringify(status) === JSON.stringify(held.status)) return;
      log.append(stream, [{ type: "bank.verified", payload: { bankId: entry.id, status } }], { tx, actor: BANKS_ACTOR });
    });
    const now = liveBank(reader, entry.id);
    readings.set(entry.id, reading === null || now === null ? reading : readingFrom(reading.files, now));
  };

  const reconcileDescribe = createDescribeLanding({ log, dataDir: options.dataDir, environmentId: options.environmentId, forge, git: options.credentials.git, landChanges: (bankId, changes) => service.landChanges(bankId, changes) });

  const verifyAll = (): Promise<BankRecord[]> => {
    verifyingAll ??= (async () => {
      try {
        for (const entry of listBanks(reader).filter((bank) => bank.enabled)) { await reconcileDescribe(entry); await reconcileLanding(entry.id); await verifyOne(entry); }
        return await records();
      } finally {
        verifyingAll = null;
      }
    })();
    return verifyingAll;
  };

  const prepareRegister = async (params: ParamsOf<"banks.register">, personalDefaults = false, checkoutOwnership: BankEntry["checkoutOwnership"] = "registered"): Promise<PreparedMethodHandler<"banks.register">> => {
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
    const preparedEntry: BankEntry = { ...draft, defaultFor: [...new Set(draft.defaultFor)], checkoutOwnership, status };
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
      // Weigh against the banks registered now, and transfer defaults atomically.
      const rejected = admission(entry, reading);
      if (rejected !== null) return { aggregate: stream, rejected };
      transferDefaults(entry, command);
      command.tx.afterCommit(() => readings.set(entry.id, reading));
      log.append(stream, [{ type: "bank.added", payload: { bank: entry } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
      return { aggregate: stream, result: { bank: recordOf(entry, reading, claims) } };
    };
  };
  const register: BankService["register"] = { prepare: (params) => prepareRegister(params) };
  const create: BankService["create"] = options.creation === undefined ? {
    prepare: () => { throw new ContractError({ code: "not_found", message: "agent-harness on this computer cannot create notebooks.", data: {} }); },
  } : createBankCommand({
    ...options.creation,
    register: (params, personalDefaults) => prepareRegister(params, personalDefaults, "managed"),
    async admit(bankId, name, files) {
      await readAll();
      if (bankEver(reader, bankId)) throw new ContractError({ code: "conflict", message: "This notebook was made already.", data: { reason: "exists", bankId } });
      if (nameHolder(reader, name) !== null) throw new ContractError({ code: "conflict", message: `You already have a notebook named ${name}.`, data: { reason: "name_taken", name } });
      const weighed = listBanks(reader).filter((bank) => bank.enabled).map((bank): Weighed => ({ ...bank, bytes: fixedBytes(readings.get(bank.id) ?? null) }));
      const conflict = overLimit(weighed, { name, accounts: "all", repositories: "all", bytes: fixedBytes(readingFrom(files, { name, role: "read-write" })) });
      if (conflict !== null) throw new ContractError({ code: "conflict", message: TOO_LONG_AT_START, data: { reason: "index_too_large", ...conflict } });
    },
  });

  const update: BankService["update"] = {
    async prepare(params) {
      const held = liveBank(reader, params.bankId);
      if (held === null) return () => ({ aggregate: stream, rejected: { code: "not_found" } });
      const { bankId } = params;
      const changes = Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== "commandId" && key !== "bankId" && value !== undefined)) as Partial<BankEntry>;
      if (changes.defaultFor !== undefined) changes.defaultFor = [...new Set(changes.defaultFor)];
      const read = await readCheckout(held.checkout, { ...held, ...changes });
      if ("problem" in read) return () => ({ aggregate: stream, rejected: { code: "invalid_params", message: read.problem, data: { issues: [] } } });
      const verdict = validateBank({ files: read.reading.files });
      if (!verdict.valid) return () => ({ aggregate: stream, rejected: { code: "validation_failed", message: "The bank's committed files fail validation.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } } });
      if (changes.pins?.some((pointer) => parseBankPointer(pointer)?.bank !== held.name || !readPointer(read.reading.index === null ? [] : [read.reading.index], pointer).found)) {
        return () => ({ aggregate: stream, rejected: { code: "not_found", message: "A registry pin names no folder in this bank." } });
      }
      const others = await readAll();
      return (_params, command) => {
        const current = liveBank(reader, bankId);
        if (current === null) return { aggregate: stream, rejected: { code: "not_found" } };
        const entry = { ...current, ...changes };
        const reading = readingFrom(read.reading.files, entry);
        const rejected = admission(entry, reading);
        if (rejected !== null) return { aggregate: stream, rejected };
        transferDefaults(entry, command);
        const changed = Object.fromEntries(Object.entries(changes).filter(([key, value]) => JSON.stringify(current[key as keyof BankEntry]) !== JSON.stringify(value)));
        if (Object.keys(changed).length > 0) log.append(stream, [{ type: "bank.updated", payload: { bankId, ...changed } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => readings.set(bankId, reading));
        return { aggregate: stream, result: { bank: recordOf(entry, reading, others.map(({ entry: bank, reading: its }) => claimOf(bank, its))) } };
      };
    },
  };

  const pin: BankService["pin"] = {
    async prepare(params) {
      const named = parseBankPointer(params.pointer);
      const entry = listBanks(reader).find((bank) => bank.name === named?.bank);
      const reading = entry === undefined || !params.pinned ? null : await readingOf(entry);
      const apply: MethodHandler<"banks.pin"> = (_params, command) => {
        if (readSummary(reader, params.sessionId) === null) {
          return { aggregate: stream, rejected: { code: "not_found", message: "The session is not present.", data: { kind: "session", sessionId: params.sessionId } } };
        }
        if (entry === undefined || liveBank(reader, entry.id) === null || (params.pinned && !readPointer(reading?.index == null ? [] : [reading.index], params.pointer).found)) {
          return { aggregate: stream, rejected: { code: "not_found", message: "The bank folder is not present." } };
        }
        const pins = sessionBankPins(reader, params.sessionId);
        if (pins.includes(params.pointer) !== params.pinned) {
          log.append(stream, [{ type: "bank.pinned", payload: { bankId: entry.id, sessionId: params.sessionId, pointer: params.pointer, pinned: params.pinned } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        }
        return { aggregate: stream, result: { sessionId: params.sessionId, pins: sessionBankPins(reader, params.sessionId) } };
      };
      return apply;
    },
  };

  const forget: BankService["forget"] = {
    prepare(params, context) {
      let staged: { readonly from: string; readonly to: string } | undefined;
      context.onUndo(() => {
        if (staged !== undefined && existsSync(staged.to)) renameSync(staged.to, staged.from);
      });
      return (_params, command) => {
        const entry = liveBank(reader, params.bankId);
        if (entry === null) return { aggregate: stream, rejected: { code: "not_found" } };
        const remove = params.removeCheckout === true;
        if (remove && !removableCheckout(entry, listBanks(reader), options.dataDir)) return { aggregate: stream, rejected: { code: "conflict", message: "Only a BankService-owned checkout with no registered path in it may be removed.", data: { reason: "registered_path", bankId: entry.id } } };
        // Rename is reversible until the receipt commits; destroy only the staged checkout after it.
        if (remove) {
          try {
            if (existsSync(entry.checkout)) {
              const root = checkoutRemovalRoot(options.dataDir);
              mkdirSync(root, { recursive: true });
              assertRemovalRoot(root, options.dataDir);
              const to = join(realpathSync(root), entry.id);
              if (protectedRemovalPath(reader, to, entry.id)) return { aggregate: stream, rejected: { code: "conflict", message: "The checkout removal path belongs to another registered bank.", data: { reason: "registered_path", bankId: entry.id } } };
              if (existsSync(to)) throw new Error("A checkout removal is pending already.");
              renameSync(entry.checkout, to);
              staged = { from: entry.checkout, to };
            }
          } catch {
            return { aggregate: stream, rejected: { code: "internal", message: "The bank's checkout could not be staged for removal; it remains registered." } };
          }
        }
        const result = { bankId: entry.id, checkoutRemoved: remove };
        log.append(stream, [{ type: "bank.forgotten", payload: result }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        command.tx.afterCommit(() => {
          readings.delete(entry.id);
          if (staged !== undefined && !protectedRemovalPath(reader, staged.to, entry.id)) rmSync(staged.to, { recursive: true, force: true });
        });
        return { aggregate: stream, result };
      };
    },
  };

  const writable = (bankId: string): BankEntry => {
    const bank = liveBank(reader, bankId);
    if (!bank || !bank.enabled || bank.role !== "read-write") throw new Error("No writable bank is registered.");
    return bank;
  };
  const service: BankService = {
    async withCheckout(bankId, work) {
      const next = (checkoutWork.get(bankId) ?? Promise.resolve()).catch(() => undefined).then(work);
      checkoutWork.set(bankId, next);
      try { return await next; }
      finally { if (checkoutWork.get(bankId) === next) checkoutWork.delete(bankId); }
    },
    configureLanding(landing) { if (lander) throw new Error("Bank landing is already configured."); lander = createBankLander({ ...landing, log, clock, environmentId: options.environmentId, banks: service }); },
    async closeLanding() { await lander?.close(); },
    promote(bankId, sessionId, drafts) {
      const bank = writable(bankId);
      if (!lander) throw new Error("Bank landing is not configured.");
      return lander.promote(bank, sessionId, drafts);
    },
    landChanges(bankId, changes) {
      const bank = writable(bankId);
      if (!lander) throw new Error("Bank landing is not configured.");
      return lander.landChanges(bank, changes);
    },
    reconcileLanding,
    git: options.credentials.git,
    list: records,
    get: async (bankId) => (await records()).find((bank) => bank.id === bankId) ?? null,
    entries: () => listBanks(reader).map((entry) => ({ entry, index: readings.get(entry.id)?.index ?? null })),
    async verify(bankId) {
      if (bankId === undefined) return verifyAll();
      const entry = liveBank(reader, bankId);
      if (entry !== null) { await reconcileDescribe(entry); await reconcileLanding(entry.id); await verifyOne(entry); }
      return records();
    },
    async recordSync(bankId, outcome) {
      const entry = liveBank(reader, bankId);
      if (entry === null) return;
      if ("head" in outcome) {
        // Clear the resolved block before inspecting: a newer verification must not retain it.
        log.atomically((tx) => {
          const held = liveBank(reader, bankId);
          if (held?.status.reachable.state !== "unreachable" || !held.status.reachable.reason.startsWith(REGISTERED_SYNC_BLOCKED)) return;
          const status: BankStatus = { ...held.status, reachable: { state: "reachable", since: clock.now().toISOString() } };
          log.append(stream, [{ type: "bank.updated", payload: { bankId, status } }], { tx, actor: BANKS_ACTOR });
        });
        await verifyOne(entry);
      }
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
    update,
    pin,
    forget,
    sessionPins: (sessionId) => sessionBankPins(reader, sessionId),
    preview: (url) => previewBank(options, url),
    join: joinBank({ ...options, register: { prepare: (params) => prepareRegister(params, false, "managed") } }),
    create,
    publish: {
      async prepare(params, context) {
        const bank = liveBank(reader, params.bankId);
        if (!bank) throw new ContractError({ code: "not_found", message: "That notebook is not on this computer.", data: {} });
        if (bank.location.kind !== "local") throw new ContractError({ code: "conflict", message: `${bank.name} is already on a forge.`, data: { reason: "not_local_only", bankId: bank.id } });
        if (!bank.enabled || bank.role !== "read-write") throw new ContractError({ code: "bank_read_only", message: `Turn on ${bank.name}, with changes allowed, before you move it.`, data: { bank: bank.name } });
        if (!lander || !options.creation) throw new ContractError({ code: "not_found", message: "agent-harness on this computer cannot move notebooks to a forge.", data: {} });
        const release = lander.reserve(bank.id);
        if (!release) throw new ContractError({ code: "conflict", message: `${bank.name} is saving a change. Try again in a moment.`, data: { reason: "landing_in_progress", bankId: bank.id } });
        context.onUndo(release);
        try {
          const publication = await prepareBankPublication({ bank, commandId: params.commandId, transferIssues: params.transferIssues === true, dataDir: options.dataDir, forge: options.creation.forge, scrub: options.scrub });
          const remote = await runGit(bank.checkout, ["remote", "get-url", "origin"], { maxBytes: 64 * 1024 });
          const oldUrl = remote.ok ? remote.stdout.toString("utf8").trim() : null;
          const installed = await runGit(bank.checkout, ["remote", oldUrl === null ? "add" : "set-url", "origin", publication.url], { maxBytes: 64 * 1024 });
          if (!installed.ok) throw new Error("The published bank's remote could not be recorded.");
          context.onUndo(async () => { await runGit(bank.checkout, oldUrl === null ? ["remote", "remove", "origin"] : ["remote", "set-url", "origin", oldUrl], { maxBytes: 64 * 1024 }); });
          const reading = await readingOf(bank);
          const claims = (await readAll()).map(({ entry, reading: its }) => claimOf(entry, its));
          return (_params, command) => {
            try {
              const current = liveBank(reader, bank.id);
              if (!current || current.location.kind !== "local") return { aggregate: stream, rejected: { code: "conflict", message: `${bank.name} changed while it was being prepared. Try again.`, data: { reason: "not_local_only", bankId: bank.id } } };
              log.append(stream, [
                { type: "bank.updated", payload: { bankId: bank.id, location: publication.location, credential: "forge", credentialEntry: null, credentialReference: null } },
                { type: "bank.review-held", payload: publication.review },
                { type: "bank.awaiting-review", payload: { bankId: bank.id, sessionId: null, pullRequest: publication.review.pullRequest } },
              ], { tx: command.tx, actor: command.actor, commandId: command.commandId });
              const entry = liveBank(reader, bank.id)!;
              return { aggregate: stream, result: { bank: recordOf(entry, reading, claims), review: { state: "awaiting-review", bank: entry.name, pullRequest: publication.review.pullRequest, files: Object.keys(publication.review.writes).map((path) => ({ path, state: "pending" })) }, followUps: publication.followUps } };
            } finally { release(); }
          };
        } catch (error) { release(); throw error; }
      },
    },
  };
  return service;
};

/** A durable staging name: the registry retains the original path even after forgetting. */
const checkoutRemovalRoot = (dataDir: string): string => join(dataDir, "bank-checkout-removals");

const assertRemovalRoot = (root: string, dataDir: string): void => {
  if (lstatSync(root).isSymbolicLink() || dirname(realpathSync(root)) !== realpathSync(dataDir)) throw new Error("The bank checkout removal directory must be a direct directory in the data directory.");
};

/** Adopting a staged path cancels its removal, even if that registration later forgets it. */
const protectedRemovalPath = (reader: Reader, path: string, bankId: string): boolean => {
  const canonical = (checkout: string): string => existsSync(checkout) ? realpathSync(checkout) : resolve(checkout);
  try {
    const staged = canonical(path);
    return reader.all<{ entry: string }>("SELECT entry FROM banks WHERE id != ?", bankId).some((row) => {
      const other = canonical((JSON.parse(row.entry) as BankEntry).checkout);
      return other === staged || other.startsWith(staged + sep) || staged.startsWith(other + sep);
    });
  } catch {
    return true;
  }
};

/** A process interruption restores an uncommitted rename, or finishes a committed removal. */
const recoverCheckoutRemovals = (reader: Reader, log: EventLog, stream: StreamRef, dataDir: string): void => {
  const root = checkoutRemovalRoot(dataDir);
  if (!existsSync(root)) return;
  assertRemovalRoot(root, dataDir);
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const [row] = reader.all<{ entry: string; forgotten_at: string | null }>("SELECT entry, forgotten_at FROM banks WHERE id = ?", directory.name);
    if (row === undefined) continue;
    const entry = JSON.parse(row.entry) as BankEntry;
    if (entry.checkoutOwnership !== "managed") throw new Error("A pending checkout removal must belong to a managed bank.");
    const staged = join(root, directory.name);
    if (protectedRemovalPath(reader, staged, entry.id)) {
      if (row.forgotten_at === null) throw new Error("The pending bank checkout cannot be restored from a path adopted by another bank.");
      continue;
    }
    if (row.forgotten_at === null) {
      if (!removableCheckout(entry, listBanks(reader), dataDir) || existsSync(entry.checkout)) throw new Error("The pending bank checkout cannot be restored into an occupied or registered path.");
      renameSync(staged, entry.checkout);
    } else if (log.readStream(stream).some((event) => event.type === "bank.forgotten" && event.payload.bankId === entry.id && event.payload.checkoutRemoved === true)) {
      try { rmSync(staged, { recursive: true, force: true }); }
      catch { console.error(`Finishing the pending checkout removal for bank ${entry.id} failed; startup will retry.`); }
    }
  }
};

/** Ownership is explicit; an old record or adopted path is never inferred to be ours from its location. */
const removableCheckout = (entry: BankEntry, banks: readonly BankEntry[], dataDir: string): boolean => {
  if (entry.checkoutOwnership !== "managed") return false;
  const canonical = (path: string): string => existsSync(path) ? realpathSync(path) : resolve(path);
  try {
    const checkout = canonical(entry.checkout);
    const root = canonical(join(dataDir, "banks"));
    if (dirname(checkout) !== root || (existsSync(entry.checkout) && lstatSync(entry.checkout).isSymbolicLink())) return false;
    return !banks.some((bank) => {
      if (bank.id === entry.id) return false;
      const other = canonical(bank.checkout);
      return other === checkout || other.startsWith(checkout + sep) || checkout.startsWith(other + sep);
    });
  } catch {
    return false;
  }
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
  enabled: params.enabled ?? true,
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
  copiedFrom: params.copiedFrom ?? null,
  createdAt: now,
});
