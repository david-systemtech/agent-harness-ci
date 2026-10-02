import { readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { terminalFolderCandidates, type SourceMachine } from "./folders.js";

export interface TerminalSourceHistory {
  readonly ts: number;
  readonly text: string;
  readonly cwd: string;
  readonly sessionId?: string;
}
export interface TerminalSourceSnippet { readonly name: string; readonly body: string; readonly updatedAt: number }
export interface TerminalSourceAfterEdit { readonly cwd: string; readonly command: string }
export type TerminalSourcePart = "history" | "snippets" | "afterEdit";
export interface TerminalSourceDiagnostic {
  readonly part: TerminalSourcePart;
  readonly reason: "unreadable" | "malformed" | "unsupported" | "invalid_record";
  readonly count: number;
}
export interface TerminalSourceRecords<T> {
  readonly status: "absent" | "read" | "partial" | "failed";
  readonly records: readonly T[];
}
export interface LocalTerminalSource {
  /** Canonical folder identity for local completion metadata, never a source document. */
  readonly sourceKey: string;
  readonly history: TerminalSourceRecords<TerminalSourceHistory>;
  readonly snippets: TerminalSourceRecords<TerminalSourceSnippet>;
  readonly afterEdit: TerminalSourceRecords<TerminalSourceAfterEdit>;
  readonly diagnostics: readonly TerminalSourceDiagnostic[];
}
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const history = (value: unknown): TerminalSourceHistory | undefined => {
  const row = object(value);
  if (!row || typeof row["ts"] !== "number" || !Number.isFinite(row["ts"]) || typeof row["text"] !== "string" || !row["text"].trim() || typeof row["cwd"] !== "string") return undefined;
  if (row["sessionId"] !== undefined && typeof row["sessionId"] !== "string") return undefined;
  return { ts: row["ts"], text: row["text"], cwd: row["cwd"], ...(typeof row["sessionId"] === "string" ? { sessionId: row["sessionId"] } : {}) };
};
const snippet = (value: unknown): TerminalSourceSnippet | undefined => {
  const row = object(value);
  if (!row || typeof row["name"] !== "string" || !/^[a-z0-9-]+$/.test(row["name"]) || typeof row["body"] !== "string") return undefined;
  return { name: row["name"], body: row["body"], updatedAt: typeof row["updatedAt"] === "number" && Number.isFinite(row["updatedAt"]) ? row["updatedAt"] : 0 };
};

/**
 * The narrow local terminal source seam (ADR 0036). Fixtures mirror the audited
 * apps/tui/src/{history,snippets,preferences}.ts writers: JSONL occurrences,
 * version-1 snippets, version-1 preferences.afterEdit. Nothing else is returned.
 * Errors are enumerated; their messages, raw input and credentials never escape.
 */
export const readLocalTerminalSource = async (machine: SourceMachine = { env: process.env, platform: process.platform, home: homedir() }): Promise<LocalTerminalSource | null> => {
  let folder: string | undefined;
  for (const candidate of terminalFolderCandidates(machine)) {
    const files = await readdir(candidate).catch(() => []);
    if (files.some((file) => ["history.jsonl", "snippets.json", "preferences.json"].includes(file))) { folder = candidate; break; }
  }
  if (!folder) return null;
  const sourceKey = await realpath(folder);
  const diagnostics: TerminalSourceDiagnostic[] = [];
  const read = async <T>(part: TerminalSourcePart, file: string, parse: (text: string) => { readonly values: readonly unknown[]; readonly convert: (value: unknown) => T | undefined }): Promise<TerminalSourceRecords<T>> => {
    let text: string;
    try { text = await readFile(join(sourceKey, file), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "absent", records: [] };
      diagnostics.push({ part, reason: "unreadable", count: 1 });
      return { status: "failed", records: [] };
    }
    let parsed: ReturnType<typeof parse>;
    try { parsed = parse(text); }
    catch (error) {
      diagnostics.push({ part, reason: error instanceof RangeError ? "unsupported" : "malformed", count: 1 });
      return { status: "failed", records: [] };
    }
    const records: T[] = [];
    let invalid = 0;
    for (const value of parsed.values) {
      const record = parsed.convert(value);
      if (record !== undefined) records.push(record); else invalid += 1;
    }
    if (invalid) diagnostics.push({ part, reason: "invalid_record", count: invalid });
    return { status: invalid ? "partial" : "read", records };
  };
  const historyRecords = await read("history", "history.jsonl", (text) => ({
    values: text.split("\n").filter((line) => line.trim()).map((line): unknown => { try { return JSON.parse(line) as unknown; } catch { return undefined; } }), convert: history,
  }));
  const snippets = await read("snippets", "snippets.json", (text) => {
    const doc = object(JSON.parse(text) as unknown);
    if (!doc || doc["version"] !== 1) throw new RangeError();
    if (!Array.isArray(doc["snippets"])) throw new SyntaxError();
    return { values: doc["snippets"], convert: snippet };
  });
  const afterEdit = await read<TerminalSourceAfterEdit>("afterEdit", "preferences.json", (text) => {
    const doc = object(JSON.parse(text) as unknown);
    if (!doc || doc["version"] !== 1) throw new RangeError();
    const preferences = object(doc["preferences"]);
    if (!preferences) throw new SyntaxError();
    const entries = preferences["afterEdit"] === undefined ? {} : object(preferences["afterEdit"]);
    if (!entries) throw new SyntaxError();
    return { values: Object.entries(entries), convert: (value) => {
      const [cwd, command] = value as [string, unknown];
      return typeof command === "string" ? { cwd, command } : undefined;
    } };
  });
  return { sourceKey, history: historyRecords, snippets, afterEdit, diagnostics };
};
