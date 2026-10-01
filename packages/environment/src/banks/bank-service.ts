import { basename } from "node:path";
import {
  BankName,
  ENVIRONMENT_STREAM_KIND,
  normaliseRemote,
  type BankEntry,
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
import type { ForgeOperations } from "../forge/operations.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, PreparedCommand, PreparedMethodHandler } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { runGit } from "../workspace/git.js";
import { readBankFiles } from "./bank-files.js";
import { indexBank, type BankIndex } from "./bank-index.js";
import { importHolder, listBanks, liveBank, nameHolder } from "./bank-store.js";
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
    const files = await readBankFiles(checkout);
    const { kind } = manifestOf(files);
    return { reading: { files, index: kind === null ? null : indexBank({ name: entry.name, kind, role: entry.role, files }) } };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
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


export interface BankServiceOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  /** The ForgeService's reads, which a remote bank's verification takes by its origin. */
  readonly forge: Pick<ForgeOperations, "repositories" | "pullRequests" | "users">;
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
  readonly register: PreparedCommand<"banks.register">;
}

export const createBankService = (options: BankServiceOptions): BankService => {
  const { log, clock, forge } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const stream: StreamRef = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  // What each bank's checkout read as when last read: its counts, line, entities and scopes come from here.
  const readings = new Map<string, Reading | null>();
  let verifyingAll: Promise<BankRecord[]> | null = null;

  const recordOf = (entry: BankEntry, reading: Reading | null | undefined): BankRecord => {
    const index = reading?.index ?? null;
    const line = index === null ? null : (renderFixedTiers(index).text.split("\n")[0] ?? null);
    return { ...entry, memories: index?.count ?? 0, folders: index?.folderCount ?? 0, line };
  };

  /** The reading held of the bank, read now when none is. */
  const readingOf = async (entry: BankEntry): Promise<Reading | null> => {
    if (readings.has(entry.id)) return readings.get(entry.id) ?? null;
    const read = await readCheckout(entry.checkout, entry);
    const reading = "reading" in read ? read.reading : null;
    readings.set(entry.id, reading);
    return reading;
  };

  const record = async (entry: BankEntry): Promise<BankRecord> => recordOf(entry, await readingOf(entry));

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

  /** The web address of an open pull request from a describe branch whose head holds `BANK.md`; null for none. */
  const manifestAwaitingReview = async (checkout: string, location: BankLocation): Promise<string | null> => {
    if (location.kind !== "remote") return null;
    const listing = await runGit(checkout, ["for-each-ref", "--sort=-refname", "--format=%(refname:short)", DESCRIBE_BRANCHES], { maxBytes: 64 * 1024 });
    const branches = listing.ok ? listing.stdout.toString("utf8").split("\n").filter((branch) => branch !== "") : [];
    for (const branch of branches) {
      const holds = await runGit(checkout, ["cat-file", "-e", `${branch}:BANK.md`], { maxBytes: 1024 });
      if (!holds.ok) continue;
      const answer = await forge.pullRequests.listByHead({ origin: location.origin, repository: location.repository, branch, limit: 5, purpose: VERIFY_PURPOSE });
      const open = answer.outcome === "done" ? answer.value.find((pullRequest) => pullRequest.state === "open") : undefined;
      if (open !== undefined) return open.url;
    }
    return null;
  };

  /** `BANK.md` on main: valid, missing or failing a rule, unless an open pull request holds one. */
  const manifestStatus = async (entry: Pick<BankEntry, "checkout" | "location">, files: BankFiles | null, since: string): Promise<BankManifestStatus> => {
    const refusal =
      files?.["BANK.md"] === undefined ? null : validateBank({ files }).findings.find((finding) => finding.severity === "refusal" && finding.path === "BANK.md");
    if (files?.["BANK.md"] !== undefined && refusal === undefined) return { state: "valid", since };
    const pullRequest = await manifestAwaitingReview(entry.checkout, entry.location);
    if (pullRequest !== null) return { state: "awaiting-review", pullRequest, since };
    if (refusal === null || refusal === undefined) return { state: "missing", since };
    return { state: "invalid", rule: refusal.rule, message: refusal.message, since };
  };

  /** A team bank's owners its forge has no user for. */
  const unresolvedOwners = async (location: BankLocation, manifest: Manifest): Promise<string[]> => {
    if (manifest.kind !== "team" || location.kind !== "remote") return [];
    const unresolved: string[] = [];
    for (const login of manifest.owners) {
      const answer = await forge.users.get({ origin: location.origin, login, purpose: VERIFY_PURPOSE });
      if (answer.outcome === "failed" && answer.status === 404) unresolved.push(login);
    }
    return unresolved;
  };

  /** What holds of the bank now: its status as found, every part since now, and its reading. */
  const inspect = async (entry: Pick<BankEntry, "name" | "role" | "checkout" | "location" | "status">): Promise<{ readonly status: BankStatus; readonly reading: Reading | null }> => {
    const since = clock.now().toISOString();
    const read = await readCheckout(entry.checkout, entry);
    const reading = "reading" in read ? read.reading : null;
    const unreachable =
      entry.location.kind === "remote" ? await reachableRemote(entry.location) : "problem" in read ? `its repository at ${entry.checkout} cannot be read: ${read.problem}` : null;
    const files = reading?.files ?? null;
    const manifest = manifestOf(files ?? {});
    const present = new Set(reading?.index?.orientation.map((memory) => memory.name) ?? []);
    const status: BankStatus = {
      reachable: unreachable === null ? { state: "reachable", since } : { state: "unreachable", reason: unreachable, since },
      manifest: await manifestStatus(entry, files, since),
      orientation: { missing: manifest.orientation.filter((name) => !present.has(name)), since },
      owners: { unresolved: await unresolvedOwners(entry.location, manifest), since },
      lastSync: entry.status.lastSync,
      landing: entry.status.landing,
    };
    return { status, reading };
  };

  /** Verifies one bank and records what changed; answers its entry after. */
  const verifyOne = async (entry: BankEntry): Promise<void> => {
    const { status: found, reading } = await inspect(entry);
    readings.set(entry.id, reading);
    log.atomically((tx) => {
      const held = liveBank(reader, entry.id);
      if (held === null) return;
      const status = keepSince(held.status, found);
      if (JSON.stringify(status) === JSON.stringify(held.status)) return;
      log.append(stream, [{ type: "bank.verified", payload: { bankId: entry.id, status } }], { tx, actor: BANKS_ACTOR });
    });
  };

  const verifyAll = (): Promise<BankRecord[]> => {
    verifyingAll ??= (async () => {
      try {
        for (const entry of listBanks(reader).filter((bank) => bank.enabled)) await verifyOne(entry);
        return await Promise.all(listBanks(reader).map(record));
      } finally {
        verifyingAll = null;
      }
    })();
    return verifyingAll;
  };

  const register: BankService["register"] = {
    async prepare(params) {
      const rejecting =
        (rejected: CommandRejection<ErrorOf<"banks.register">["code"]>): PreparedMethodHandler<"banks.register"> =>
        () => ({ aggregate: stream, rejected });
      const imported = params.importedFrom === undefined ? null : importHolder(reader, params.importedFrom);
      if (imported !== null) {
        const held = liveBank(reader, imported);
        const answer = held === null ? null : await record(held);
        return () => (answer === null ? { aggregate: stream, rejected: { code: "not_found" } } : { aggregate: stream, result: { bank: answer } });
      }
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
      const entry: BankEntry = { ...draft, status };
      return (_params, command) => {
        if (nameHolder(reader, entry.name) !== null) {
          return { aggregate: stream, rejected: { code: "conflict", message: `Another bank is named ${entry.name}.`, data: { reason: "name_taken", name: entry.name } } };
        }
        command.tx.afterCommit(() => readings.set(entry.id, reading));
        log.append(stream, [{ type: "bank.added", payload: { bank: entry } }], { tx: command.tx, actor: command.actor, commandId: command.commandId });
        return { aggregate: stream, result: { bank: recordOf(entry, reading) } };
      };
    },
  };

  return {
    list: async () => Promise.all(listBanks(reader).map(record)),
    async get(bankId) {
      const entry = liveBank(reader, bankId);
      return entry === null ? null : record(entry);
    },
    entries: () => listBanks(reader).map((entry) => ({ entry, index: readings.get(entry.id)?.index ?? null })),
    async verify(bankId) {
      if (bankId === undefined) return verifyAll();
      const entry = liveBank(reader, bankId);
      if (entry !== null) await verifyOne(entry);
      return Promise.all(listBanks(reader).map(record));
    },
    register,
  };
};

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
