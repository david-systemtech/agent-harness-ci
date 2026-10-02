import { join } from "node:path";
import { HISTORY_FILE, HISTORY_MAX_ENTRIES, HISTORY_KEPT_ENTRIES, parseHistoryEntries, type HistoryEntry } from "../composer/history.js";
import { SNIPPETS_FILE, parseSnippets, serialiseSnippets, type Snippet } from "../composer/snippets.js";
import { withTerminalFiles, type TerminalCommitFaults, type TerminalWrite } from "./terminal-files.js";

/** Imported text stays inert here until explicitly saved to the Environment by the user. */
export const AFTER_EDIT_DOCUMENT = "terminal.afterEdit";
const COMPLETION_FILE = "terminal-import.json";
export type TerminalPart = "history" | "snippets" | "afterEdit";
export interface TerminalBatch {
  readonly sourceKey: string;
  /** Fully valid parts to mark; partial parts may persist records without completion. Preset: all supplied parts. */
  readonly completed?: readonly TerminalPart[];
  readonly history?: readonly HistoryEntry[];
  readonly snippets?: readonly Snippet[];
  readonly afterEdit?: readonly { readonly cwd: string; readonly command: string }[];
}
type Completion = Record<string, TerminalPart[]>;
const completion = (text: string | undefined): Completion => {
  if (text === undefined) return {};
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.values(value).some((parts: unknown) => !Array.isArray(parts) || parts.some((part: unknown) => !["history", "snippets", "afterEdit"].includes(String(part))))) {
    throw new Error("Terminal completion metadata is invalid.");
  }
  return value as Completion;
};

/** The caller normalises/validates records and supplies valid records and identifies fully successful parts; no source is read here. */
export const commitTerminalBatch = (dir: string, batch: TerminalBatch, faults?: TerminalCommitFaults): readonly TerminalPart[] =>
  withTerminalFiles(dir, (files) => {
    const marker = join(dir, COMPLETION_FILE);
    const sources = completion(files.read(marker));
    const parts = Object.hasOwn(sources, batch.sourceKey) ? sources[batch.sourceKey] ?? [] : [];
    const writes: TerminalWrite[] = [];
    if (batch.history !== undefined && !parts.includes("history")) {
      const path = join(dir, HISTORY_FILE);
      const seen = new Set<string>();
      let entries = [...parseHistoryEntries(files.read(path) ?? ""), ...batch.history].filter((entry) => {
        const occurrence = JSON.stringify([entry.ts, entry.text]);
        if (seen.has(occurrence)) return false;
        seen.add(occurrence);
        return true;
      }).sort((a, b) => a.ts - b.ts);
      if (entries.length > HISTORY_MAX_ENTRIES) entries = entries.slice(-HISTORY_KEPT_ENTRIES);
      writes.push({ path, text: entries.map((entry) => `${JSON.stringify(entry)}\n`).join("") });
      if (batch.completed === undefined || batch.completed.includes("history")) parts.push("history");
    }
    if (batch.snippets !== undefined && !parts.includes("snippets")) {
      const path = join(dir, SNIPPETS_FILE);
      const snippets = parseSnippets(files.read(path) ?? "");
      for (const snippet of batch.snippets) if (!snippets.has(snippet.name)) snippets.set(snippet.name, snippet);
      writes.push({ path, text: serialiseSnippets([...snippets.values()]) });
      if (batch.completed === undefined || batch.completed.includes("snippets")) parts.push("snippets");
    }
    if (batch.afterEdit !== undefined && !parts.includes("afterEdit")) {
      const path = join(dir, "documents", `${AFTER_EDIT_DOCUMENT}.json`);
      const text = files.read(path);
      const entries = text === undefined ? {} : JSON.parse(text) as Record<string, string>;
      for (const entry of batch.afterEdit) if (!Object.hasOwn(entries, entry.cwd)) Object.defineProperty(entries, entry.cwd, { value: entry.command, enumerable: true });
      writes.push({ path, text: `${JSON.stringify(entries)}\n` });
      if (batch.completed === undefined || batch.completed.includes("afterEdit")) parts.push("afterEdit");
    }
    if (writes.length > 0) {
      Object.defineProperty(sources, batch.sourceKey, { value: parts, enumerable: true, configurable: true });
      writes.push({ path: marker, text: `${JSON.stringify(sources)}\n` });
      files.commit(writes, faults);
    }
    return [...parts];
  });

/** A read also recovers any committed batch before reporting completion. */
export const terminalCompletion = (dir: string, sourceKey: string): readonly TerminalPart[] => withTerminalFiles(dir, (files) => {
  const sources = completion(files.read(join(dir, COMPLETION_FILE)));
  return Object.hasOwn(sources, sourceKey) ? sources[sourceKey] ?? [] : [];
});
