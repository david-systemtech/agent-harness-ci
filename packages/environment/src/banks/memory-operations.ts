import { stringify } from "yaml";
import {
  ContractError, ENVIRONMENT_STREAM_KIND, parseBankPointer,
  type BankDraft, type BankEntry, type BankFinding, type MemoryDraftInput, type MemoryPromoteInput, type MemoryPromoteResult, type MemoryReadInput, type MemoryRetireInput, type MemorySearchInput,
} from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import type { EventLog } from "../event-log/event-log.js";
import type { ScrubRegistry } from "../scrub/registry.js";
import { indexBank } from "./bank-index.js";
import { readPointer, searchBanks, pointerFolder } from "./index-renderer.js";
import { readBankFiles } from "./bank-files.js";
import { BANKS_ACTOR } from "./bank-service.js";
import { listBanks } from "./bank-store.js";
import { bankInScope } from "./scope.js";
import { recordBankUse } from "./session-relevance.js";
import { listBankDrafts } from "./draft-store.js";

/**
 * The memory operations (banks spec, "The memory tools"): search, read,
 * draft, retire and promote over the banks in a caller's scope, shared by
 * the `memory` tool server of a run and the `banks.memory.*` methods the
 * CLI's `bank` verbs call from outside the harness (#1044), so both answer
 * alike and changes to one queue are serialized whichever of them asks.
 * Drafts and retirements only queue; promotion owns every checkout write and
 * the queue's consumption.
 */

/** Who asks: the account and repository that scope its banks. */
export interface MemoryCaller {
  /** The account whose banks are in scope; null for none, under which only banks scoped to every account are. */
  readonly accountId: string | null;
  /** The repository the caller works in; null for none, under which only banks scoped to every repository are. */
  readonly repositoryIdentity: string | null;
  /**
   * The run's session whose recent use the folders read, searched and
   * drafted into become (banks spec, "Relevance"); none for a caller outside
   * the harness, whose calls lead no session's index.
   */
  readonly usedBy?: string;
}

/** A caller with a draft queue: a run's session, or a caller outside the harness under its own session's id. */
export interface QueueCaller extends MemoryCaller {
  /** The session whose queue drafts and retirements join and promote lands, per bank (banks spec, "Drafts"). */
  readonly queue: string;
}

/** A change queued for a bank, as the queue holds it. */
export interface QueuedChange {
  readonly bank: string;
  readonly change: BankDraft;
}

export interface MemoryOperations {
  /** The enabled banks in the caller's scope, as the registry holds them now. */
  inScope(caller: MemoryCaller): BankEntry[];
  /** Memories, folder and topic lines, orientation and entity aliases matching the query, each as its pointer and line, then "n of N". */
  search(caller: MemoryCaller, input: MemorySearchInput): Promise<string>;
  /** What a pointer reads: every bank's line with none, a bank's root, a folder's or topic's index, a memory's file; each ending with its folder and count. */
  read(caller: MemoryCaller, input: MemoryReadInput): Promise<string>;
  /** Validates a memory and queues it for the caller's session and the bank; a draft of a name the bank or queue holds replaces it. */
  draft(caller: QueueCaller, input: MemoryDraftInput): Promise<QueuedChange>;
  /** Queues the removal of a memory the bank or queue holds, for the next promote. */
  retire(caller: QueueCaller, input: MemoryRetireInput): Promise<QueuedChange>;
  /** Lands the caller's queue for the bank through the Lander, answering each file's state on main, the review, or the failure. */
  promote(caller: QueueCaller, input: MemoryPromoteInput): Promise<MemoryPromoteResult>;
}

const refuse = (code: "not_found" | "invalid_params", message: string): never => { throw new ContractError({ code, message, data: {} }); };
const apply = (files: BankFiles, drafts: readonly BankDraft[]): BankFiles => {
  const next = { ...files };
  for (const change of drafts) {
    for (const path of change.removePaths ?? []) delete next[path];
    if (change.kind === "retire") delete next[change.path];
    else next[change.path] = change.content;
  }
  return next;
};
const pathOfName = (files: BankFiles, name: string): string | undefined => bankTreeOf(Object.keys(files)).memories.find(({ path }) => {
  const file = readBankMarkdown(files[path] ?? "");
  return file.ok && file.data.name === name;
})?.path;
const unavailableLines = (names: readonly string[]) => names.map((name) => `${name} — could not be read\n`).join("");

export const createMemoryOperations = ({ log, environmentId, scrub, promote }: {
  log: EventLog; environmentId: string; scrub: ScrubRegistry;
  promote: (bank: BankEntry, sessionId: string, drafts: readonly BankDraft[]) => Promise<MemoryPromoteResult>;
}): MemoryOperations => {
  const reader = { all: <T>(sql: string, ...params: readonly (string | number | null)[]) => log.read<T>(sql, ...params) };
  // Reading git is asynchronous: serialize changes to the same queue so each validator sees the preceding write.
  const pending = new Map<string, Promise<unknown>>();
  const inScope = (caller: MemoryCaller) => listBanks(reader).filter((bank) => bankInScope(bank, caller));
  const used = (caller: MemoryCaller, pointers: readonly string[]) => {
    if (caller.usedBy === undefined) return;
    for (const bank of inScope(caller)) recordBankUse(log, caller.usedBy, bank.id, pointers.filter((pointer) => parseBankPointer(pointer)?.bank === bank.name));
  };
  const indices = async (caller: MemoryCaller, name?: string) => {
    const entries = inScope(caller).filter((bank) => name === undefined || bank.name === name);
    const results = await Promise.allSettled(entries.map(async (bank) => indexBank({ ...bank, files: await readBankFiles(bank.checkout) })));
    const live = new Set(inScope(caller).map((bank) => bank.id));
    const scoped = results.flatMap((result, i) => live.has(entries[i]!.id) ? [{ result, entry: entries[i]! }] : []);
    return {
      banks: scoped.flatMap(({ result }) => result.status === "fulfilled" ? [result.value] : []),
      unavailable: scoped.flatMap(({ result, entry }) => result.status === "rejected" ? [entry.name] : []),
    };
  };
  const target = (caller: MemoryCaller, name?: string): BankEntry => {
    const banks = inScope(caller);
    const writable = banks.filter((bank) => bank.role === "read-write");
    if (name === undefined && writable.length > 1) throw new ContractError({ code: "bank_required", message: "Name one of the writable banks in scope.", data: { banks: writable.map((bank) => bank.name) } });
    const bank = name === undefined ? writable[0] : banks.find((bank) => bank.name === name);
    if (!bank) return refuse("not_found", "No matching writable bank is in scope.");
    if (bank.role === "read-only") throw new ContractError({ code: "bank_read_only", message: "The named bank is read-only.", data: { bank: bank.name } });
    return bank;
  };
  /** Runs `work` after the queue's earlier changes, and before its later ones. */
  const serialized = async <T>(caller: QueueCaller, bank: BankEntry, work: () => Promise<T>): Promise<T> => {
    const key = `${caller.queue}:${bank.id}`;
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
    pending.set(key, next);
    try { return await next; } finally { if (pending.get(key) === next) pending.delete(key); }
  };
  const queue = (caller: QueueCaller, bank: BankEntry, make: (files: BankFiles, drafts: readonly BankDraft[]) => BankDraft): Promise<BankDraft> => serialized(caller, bank, async () => {
    const drafts = listBankDrafts(reader, caller.queue, bank.id)[0]?.drafts ?? [];
    const files = apply(await readBankFiles(bank.checkout), drafts);
    const proposed = make(files, drafts);
    const held = drafts.find((draft) => draft.name === proposed.name);
    const removePaths = [...new Set([...(held?.removePaths ?? []), ...(held !== undefined && held.path !== proposed.path ? [held.path] : []), ...(proposed.removePaths ?? [])])].filter((path) => path !== proposed.path);
    const change: BankDraft = { ...proposed, ...(removePaths.length > 0 && { removePaths }) };
    const writes = { ...Object.fromEntries(removePaths.map((path) => [path, null])), [change.path]: change.kind === "draft" ? change.content : null };
    const verdict = validateBank({ files, writes });
    const findings: BankFinding[] = [...verdict.findings];
    // The registry also knows secret values and their encoded forms that bank CI cannot know.
    const fields = change.kind === "draft" ? { content: change.content } : { reason: change.reason };
    for (const [field, text] of Object.entries(fields)) {
      const secret = scrub.check(text);
      if (secret !== null && !findings.some((finding) => finding.rule === "secret_shaped")) findings.push({ rule: "secret_shaped", severity: "refusal", path: change.path, field, secret, message: `The ${field} contains a secret-shaped string (${secret}); remove it.` });
    }
    const refusals = findings.filter((finding) => finding.severity === "refusal");
    if (refusals.length > 0) throw new ContractError({ code: "validation_failed", message: "The bank validator refused this change.", data: { rules: [...new Set(refusals.map((finding) => finding.rule))], findings: findings.map((finding) => ({ ...finding, path: scrub.scrubOutput(finding.path), message: scrub.scrubOutput(finding.message) })) } });
    // The bank may have been disabled or made read-only while git was read.
    if (target(caller, bank.name).id !== bank.id) return refuse("not_found", "The bank left the registry while the change was validated.");
    log.atomically((tx) => log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "bank.draft-queued", payload: { sessionId: caller.queue, bankId: bank.id, change } }], { tx, actor: BANKS_ACTOR }));
    return change;
  });

  return {
    inScope,
    async search(caller, input) {
      if (input.query.trim() === "") return refuse("invalid_params", "The search input does not match its published schema.");
      const { banks, unavailable } = await indices(caller, input.bank);
      if (input.bank !== undefined && unavailable.includes(input.bank)) return refuse("not_found", `${input.bank} could not be read.`);
      if (input.bank !== undefined && !banks.some((bank) => bank.name === input.bank)) return refuse("not_found", "No matching bank is in scope.");
      const answer = searchBanks(banks, input);
      used(caller, answer.hits.flatMap((hit) => hit.folder === null ? [] : [hit.folder]));
      const missing = unavailable.length === 0 ? "" : `${unavailableLines(unavailable)}Search covers readable banks only.\n`;
      return missing + answer.text;
    },
    async read(caller, input) {
      const name = parseBankPointer(input.pointer ?? "")?.bank;
      const { banks, unavailable } = await indices(caller, name);
      if (name !== undefined && unavailable.includes(name)) return refuse("not_found", `${name} could not be read.`);
      const answer = readPointer(banks, input.pointer);
      if (!answer.found) return refuse("not_found", answer.message);
      const folder = input.pointer === undefined ? null : pointerFolder(banks, input.pointer);
      if (folder !== null) used(caller, [folder]);
      return answer.text + unavailableLines(unavailable);
    },
    async draft(caller, draft) {
      const bank = target(caller, draft.bank);
      const change = await queue(caller, bank, (files) => {
        const folder = ["projects", draft.scope.org, draft.scope.project, ...(draft.scope.area ? [draft.scope.area] : []), "memories", ...(draft.topic ? [draft.topic] : [])].join("/");
        const old = pathOfName(files, draft.name);
        // Bad names still reach the validator, but never become paths or expose a secret in a finding's path.
        const stem = /^[a-z0-9][a-z0-9-]{0,59}$/.test(draft.name) ? draft.name : "invalid-memory-name";
        const path = `${folder}/${stem}.md`;
        const content = `---\n${stringify({ name: draft.name, description: draft.description, metadata: { type: draft.type, ...(draft.appliesTo && { applies_to: draft.appliesTo }) } }, { lineWidth: 0 })}---\n${draft.body}`;
        return { kind: "draft", name: draft.name, path, content, ...(old !== undefined && old !== path && { removePaths: [old] }) };
      });
      used(caller, [`${bank.name}:${[draft.scope.org, draft.scope.project, ...(draft.scope.area ? [draft.scope.area] : [])].join("/")}/`]);
      return { bank: bank.name, change };
    },
    async retire(caller, { bank: name, ...retire }) {
      const bank = target(caller, name);
      const change = await queue(caller, bank, (files, drafts) => {
        // A prior retirement has already removed the file from the proposed view.
        const path = pathOfName(files, retire.name) ?? drafts.find((draft) => draft.name === retire.name)?.path;
        if (!path) return refuse("not_found", "The memory named for retirement is not in the bank or queue.");
        return { kind: "retire", path, ...retire };
      });
      return { bank: bank.name, change };
    },
    async promote(caller, input) {
      const bank = target(caller, input.bank);
      return serialized(caller, bank, async () => promote(target(caller, bank.name), caller.queue, listBankDrafts(reader, caller.queue, bank.id)[0]?.drafts ?? []));
    },
  };
};
