import { stringify } from "yaml";
import { z } from "zod";
import {
  ContractError, ENVIRONMENT_STREAM_KIND, MemoryDraftInput, MemoryRetireInput, MemoryPromoteInput, MemoryReadInput, MemorySearchInput, parseBankPointer,
  type BankDraft, type BankEntry, type BankFinding, type MemoryPromoteResult,
} from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import type { InProcessToolServer } from "../adapter/contract.js";
import type { ToolServerFactory } from "../adapter/seams.js";
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

/** Tools queue changes only; promotion owns all checkout writes and queue consumption. */
export const createMemoryToolServers = ({ log, environmentId, scrub, promote }: { log: EventLog; environmentId: string; scrub: ScrubRegistry; promote: (bank: BankEntry, sessionId: string, drafts: readonly BankDraft[]) => Promise<MemoryPromoteResult> }): ToolServerFactory => {
  const reader = { all: <T>(sql: string, ...params: readonly (string | number | null)[]) => log.read<T>(sql, ...params) };
  // Reading git is asynchronous: serialize changes to the same queue so each validator sees the preceding write.
  const pending = new Map<string, Promise<unknown>>();
  return (scope) => {
    const available = () => listBanks(reader).filter((bank) => bankInScope(bank, scope));
    if (available().length === 0) return [];
    const used = (pointers: readonly string[]) => {
      for (const bank of available()) recordBankUse(log, scope.sessionId, bank.id, pointers.filter((pointer) => parseBankPointer(pointer)?.bank === bank.name));
    };
    const indices = async () => {
      const entries = available();
      const banks = await Promise.all(entries.map(async (bank) => indexBank({ ...bank, files: await readBankFiles(bank.checkout) })));
      const live = new Set(available().map((bank) => bank.id));
      return banks.filter((_, i) => live.has(entries[i]!.id));
    };
    const target = (name?: string): BankEntry => {
      const banks = available();
      const writable = banks.filter((bank) => bank.role === "read-write");
      if (name === undefined && writable.length > 1) throw new ContractError({ code: "bank_required", message: "Name one of the writable banks in scope.", data: { banks: writable.map((bank) => bank.name) } });
      const bank = name === undefined ? writable[0] : banks.find((bank) => bank.name === name);
      if (!bank) return refuse("not_found", "No matching writable bank is in scope.");
      if (bank.role === "read-only") throw new ContractError({ code: "bank_read_only", message: "The named bank is read-only.", data: { bank: bank.name } });
      return bank;
    };
    const queue = async (bank: BankEntry, make: (files: BankFiles, drafts: readonly BankDraft[]) => BankDraft): Promise<BankDraft> => {
      const key = `${scope.sessionId}:${bank.id}`;
      const earlier = pending.get(key) ?? Promise.resolve();
      const work = earlier.catch(() => undefined).then(async () => {
        const drafts = listBankDrafts(reader, scope.sessionId, bank.id)[0]?.drafts ?? [];
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
        if (target(bank.name).id !== bank.id) return refuse("not_found", "The bank left the registry while the change was validated.");
        log.atomically((tx) => log.append({ kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, [{ type: "bank.draft-queued", payload: { sessionId: scope.sessionId, bankId: bank.id, change } }], { tx, actor: BANKS_ACTOR }));
        return change;
      });
      pending.set(key, work);
      try { return await work; } finally { if (pending.get(key) === work) pending.delete(key); }
    };
    const server: InProcessToolServer = {
      name: "memory", external: false,
      tools: [
        {
          name: "search", description: "Search memories, folder and topic lines, orientation and entity aliases in banks in scope. Every answer reports n of N, including limited results.",
          inputSchema: z.toJSONSchema(MemorySearchInput),
          call: async (input) => {
            try {
              const parsed = MemorySearchInput.safeParse(input);
              if (!parsed.success || parsed.data.query.trim() === "") return refuse("invalid_params", "The search input does not match its published schema.");
              const banks = await indices();
              if (parsed.data.bank !== undefined && !banks.some((bank) => bank.name === parsed.data.bank)) return refuse("not_found", "No matching bank is in scope.");
              const answer = searchBanks(banks, parsed.data);
              used(answer.hits.flatMap((hit) => hit.folder === null ? [] : [hit.folder]));
              return { text: answer.text, isError: false };
            } catch (error) { return answerError(error); }
          },
        },
        {
          name: "read", description: "Follow a bank, folder, topic or memory pointer. Without a pointer, list every bank in scope; reads carry the neighboring folder and count.",
          inputSchema: z.toJSONSchema(MemoryReadInput),
          call: async (input) => {
            try {
              const parsed = MemoryReadInput.safeParse(input);
              if (!parsed.success) return refuse("invalid_params", "The read input does not match its published schema.");
              const banks = await indices();
              const answer = readPointer(banks, parsed.data.pointer);
              if (!answer.found) return refuse("not_found", answer.message);
              const folder = parsed.data.pointer === undefined ? null : pointerFolder(banks, parsed.data.pointer);
              if (folder !== null) used([folder]);
              return { text: answer.text, isError: false };
            } catch (error) { return answerError(error); }
          },
        },
        {
          name: "promote", description: "Land this session's queued drafts and removals in a bank, returning each file's state on main or the review pull request.",
          inputSchema: z.toJSONSchema(MemoryPromoteInput),
          call: async (input) => {
            try {
              const parsed = MemoryPromoteInput.safeParse(input);
              if (!parsed.success) return refuse("invalid_params", "The promote input does not match its published schema.");
              const bank = target(parsed.data.bank);
              const key = `${scope.sessionId}:${bank.id}`;
              const earlier = pending.get(key) ?? Promise.resolve();
              const work = earlier.catch(() => undefined).then(async () => {
                const current = target(bank.name);
                const drafts = listBankDrafts(reader, scope.sessionId, bank.id)[0]?.drafts ?? [];
                return promote(current, scope.sessionId, drafts);
              });
              pending.set(key, work);
              try {
                const answer = await work;
                return { text: JSON.stringify(answer), isError: answer.state === "failed" };
              } finally { if (pending.get(key) === work) pending.delete(key); }
            } catch (error) { return answerError(error); }
          },
        },
        {
          name: "draft", description: "Validate and queue one memory for this session. Name a bank when several are writable; use org, project and optional area scope.",
          inputSchema: z.toJSONSchema(MemoryDraftInput),
          call: async (input) => {
            try {
              const parsed = MemoryDraftInput.safeParse(input);
              if (!parsed.success) return refuse("invalid_params", "The draft input does not match its published schema.");
              const draft = parsed.data;
              const bank = target(draft.bank);
              const change = await queue(bank, (files) => {
                const folder = ["projects", draft.scope.org, draft.scope.project, ...(draft.scope.area ? [draft.scope.area] : []), "memories", ...(draft.topic ? [draft.topic] : [])].join("/");
                const old = pathOfName(files, draft.name);
                // Bad names still reach the validator, but never become paths or expose a secret in a finding's path.
                const stem = /^[a-z0-9][a-z0-9-]{0,59}$/.test(draft.name) ? draft.name : "invalid-memory-name";
                const path = `${folder}/${stem}.md`;
                const content = `---\n${stringify({ name: draft.name, description: draft.description, metadata: { type: draft.type, ...(draft.appliesTo && { applies_to: draft.appliesTo }) } }, { lineWidth: 0 })}---\n${draft.body}`;
                return { kind: "draft", name: draft.name, path, content, ...(old !== undefined && old !== path && { removePaths: [old] }) };
              });
              used([`${bank.name}:${[draft.scope.org, draft.scope.project, ...(draft.scope.area ? [draft.scope.area] : [])].join("/")}/`]);
              return { text: JSON.stringify({ bank: bank.name, ...change }), isError: false };
            } catch (error) { return answerError(error); }
          },
        },
        {
          name: "retire", description: "Queue removal of a named memory in a bank, with a reason, for the next promote.",
          inputSchema: z.toJSONSchema(MemoryRetireInput),
          call: async (input) => {
            try {
              const parsed = MemoryRetireInput.safeParse(input);
              if (!parsed.success) return refuse("invalid_params", "The retirement input does not match its published schema.");
              const { bank: name, ...retire } = parsed.data;
              const bank = target(name);
              const change = await queue(bank, (files, drafts) => {
                // A prior retirement has already removed the file from the proposed view.
                const path = pathOfName(files, retire.name) ?? drafts.find((draft) => draft.name === retire.name)?.path;
                if (!path) return refuse("not_found", "The memory named for retirement is not in the bank or queue.");
                return { kind: "retire", path, ...retire };
              });
              return { text: JSON.stringify({ bank: bank.name, ...change }), isError: false };
            } catch (error) { return answerError(error); }
          },
        },
      ],
    };
    return [server];
  };
};

const answerError = (error: unknown) => ({
  text: JSON.stringify(error instanceof ContractError ? error.toWire() : { code: "internal", message: "The bank could not be read or changed.", data: {} }), isError: true,
});
