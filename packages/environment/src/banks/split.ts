import { stringify } from "yaml";
import { ContractError, ENVIRONMENT_STREAM_KIND, parseBankPointer, type BankEntry } from "@agent-harness/contracts";
import { bankTreeOf, readBankMarkdown, validateBank, type BankFiles } from "@agent-harness/contracts/bank-validator";
import { runGit } from "../workspace/git.js";
import type { MethodHandlers } from "../serve/methods.js";
import { readBankFiles } from "./bank-files.js";
import type { BankService } from "./bank-service.js";

const refuse = (code: "invalid_params" | "not_found", message: string): never => { throw new ContractError({ code, message, data: {} }); };

/** Splitting is explicit authoring through the bank methods; a proposal is only a read of committed memory names. */
export const splitMethods = (banks: BankService, environmentId: string): MethodHandlers => {
  const target = (pointer: string): { bank: BankEntry; scope: string } => {
    const parsed = parseBankPointer(pointer);
    if (parsed?.kind !== "folder") return refuse("invalid_params", "Choose a project or area folder to split.");
    const bank = banks.entries().find(({ entry }) => entry.enabled && entry.name === parsed.bank)?.entry;
    if (!bank) return refuse("not_found", "The bank named by the folder pointer is not enabled in the registry.");
    return { bank, scope: `projects/${parsed.path}` };
  };
  const memoriesIn = (files: BankFiles, scope: string) => {
    const tree = bankTreeOf(Object.keys(files));
    if (!tree.projects.has(scope) && !tree.areas.has(scope)) return refuse("not_found", "The pointer does not name a project or area folder in this bank.");
    return tree.memories.filter((memory) => memory.scope === scope).map((memory) => {
      const file = readBankMarkdown(files[memory.path] ?? "");
      if (!file.ok || typeof file.data.name !== "string") return refuse("invalid_params", "A memory in the folder has no parsing name.");
      return { ...memory, name: file.data.name };
    }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  };
  return {
    "banks.split.apply": {
      async prepare({ pointer, topics }) {
        const { bank, scope } = target(pointer);
        if (bank.role === "read-only") throw new ContractError({ code: "bank_read_only", message: "The bank named by the pointer is read-only.", data: { bank: bank.name } });
        if (Object.keys(topics).length === 0) return refuse("invalid_params", "Accept at least one authored topic before applying a split.");
        const head = await runGit(bank.checkout, ["rev-parse", "HEAD"], { maxBytes: 1024 });
        if (!head.ok || head.truncated) return refuse("not_found", "The bank's committed head could not be read.");
        const expectedHead = head.stdout.toString("utf8").trim();
        const files = await readBankFiles(bank.checkout, expectedHead);
        const memories = memoriesIn(files, scope);
        const artefact = `${scope}${scope.split("/").length === 4 ? "PROJECT.md" : "AREA.md"}`;
        const folder = readBankMarkdown(files[artefact] ?? "");
        if (!folder.ok) return refuse("invalid_params", "The scope folder needs a parsing project or area artefact before it can be split.");
        const writes: Record<string, string | null> = {};
        const assigned = new Set<string>();
        for (const [topic, authored] of Object.entries(topics)) {
          for (const name of authored.memories) {
            if (assigned.has(name)) return refuse("invalid_params", "A memory may be accepted into only one topic.");
            const memory = memories.find((memory) => memory.name === name && memory.topic === null);
            if (!memory) return refuse("invalid_params", "Every accepted memory must be a flat memory in the pointed folder.");
            const destination = `${scope}memories/${topic}/${memory.stem}.md`;
            if (Object.hasOwn(files, destination)) return refuse("invalid_params", "A moved memory must not replace a file already in the topic.");
            assigned.add(name);
            writes[memory.path] = null;
            writes[destination] = files[memory.path]!;
          }
        }
        const declarations = typeof folder.data.topics === "object" && folder.data.topics !== null && !Array.isArray(folder.data.topics) ? folder.data.topics : {};
        writes[artefact] = `---\n${stringify({ ...folder.data, topics: { ...declarations, ...Object.fromEntries(Object.entries(topics).map(([name, topic]) => [name, topic.line])) } }, { lineWidth: 0 })}---\n${folder.body}`;
        const verdict = validateBank({ files, writes });
        if (!verdict.valid) throw new ContractError({ code: "validation_failed", message: "The bank validator refused the authored split.", data: { rules: [...new Set(verdict.findings.filter((finding) => finding.severity === "refusal").map((finding) => finding.rule))], findings: verdict.findings } });
        // I/O and review events belong to the Lander, outside the command receipt's transaction.
        const landing = await banks.landChanges(bank.id, { writes, expectedHead, title: "Split a scope folder into authored topics", body: "Declare accepted topics and move memories without changing their names or links." });
        return () => ({ aggregate: { kind: ENVIRONMENT_STREAM_KIND, id: environmentId }, result: { landing } });
      },
    },
    "banks.split.propose": async ({ pointer }) => {
      const { bank, scope } = target(pointer);
      const memories = memoriesIn(await readBankFiles(bank.checkout), scope);
      const groups = new Map<string, string[]>();
      for (const memory of memories.filter((memory) => memory.topic === null)) {
        const prefix = memory.name.split("-")[0]!;
        groups.set(prefix, [...(groups.get(prefix) ?? []), memory.name]);
      }
      return { pointer, count: memories.length, clusters: [...groups].map(([prefix, names]) => ({ prefix, memories: names })) };
    },
  };
};
