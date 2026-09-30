import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSessionInfo } from "../../adapter/contract.js";
import type { ConfigDirQueue } from "./config-dir-queue.js";

/**
 * The sessions of an account's config directory, for Carry over (ADR 0021,
 * #578): the SDK's standalone `listSessions` with no project named, under
 * the config-directory queue, which lists every project folder of
 * `projects/` in the directory the queue installs.
 *
 * What the pinned SDK (0.3.283) leaves out, read from its source: a
 * transcript whose file name is not a session id; a subagent's transcript
 * (its session's folder is not read, and one at the top of a project opens
 * with `isSidechain`); a superseded transcript, one whose tail says it
 * continued in another session whose transcript is there; and a transcript
 * with no title, summary or prompt to name it. A session id found in two
 * project folders is listed once, as last written. It lists SDK-driven
 * sessions too, as the harness's own and other programs' are.
 *
 * What the SDK reads is a transcript's first and last 64 kB, so its info
 * can lack the working directory (a large first record pushes the first
 * one that names it past them) and the first prompt (it passes over a
 * prompt that opens with a tag, as the scheduler's opening turn does).
 * Only then is the transcript's first lines read, for either. A transcript
 * that names no working directory even so is orphaned (a summary of a
 * conversation whose records are gone) and is left out: there is nowhere
 * it could be resumed.
 */

/** How far into a transcript its first lines are read for a working directory and a first prompt. */
const OPENING_LINES = 50;

/** The longest first prompt the listing gives, as the SDK's own is cut (with an ellipsis past it). */
const PROMPT_MAX = 200;

/** What a transcript's first lines say: the working directory its first record names, and its first prompt. */
interface Opening {
  readonly workingDirectory: string | null;
  readonly firstPrompt: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text a user record's prompt carries: its string, or its text blocks; null for a tool's result, a meta record or none. */
const promptOf = (record: Record<string, unknown>): string | null => {
  if (record["type"] !== "user" || record["isMeta"] === true || record["isCompactSummary"] === true) return null;
  const content = isRecord(record["message"]) ? record["message"]["content"] : undefined;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content.filter(isRecord) : [];
  if (blocks.some((block) => block["type"] === "tool_result")) return null;
  const text = blocks
    .flatMap((block) => (block["type"] === "text" && typeof block["text"] === "string" ? [block["text"]] : []))
    .join(" ")
    .replaceAll("\n", " ")
    .trim();
  if (text === "") return null;
  return text.length > PROMPT_MAX ? `${text.slice(0, PROMPT_MAX).trim()}…` : text;
};

/** The working directory and first prompt a transcript's first lines give; nothing for a file that cannot be read. */
const readOpening = async (path: string): Promise<Opening> => {
  let workingDirectory: string | null = null;
  let firstPrompt: string | null = null;
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    let read = 0;
    for await (const text of lines) {
      if (++read > OPENING_LINES || (workingDirectory !== null && firstPrompt !== null)) break;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        // A record cut short by a process killed mid-write says nothing.
        continue;
      }
      if (!isRecord(record)) continue;
      if (workingDirectory === null && typeof record["cwd"] === "string" && record["cwd"] !== "") workingDirectory = record["cwd"];
      firstPrompt ??= promptOf(record);
    }
  } catch {
    // A transcript that cannot be read gives nothing more than the SDK's info did.
  } finally {
    lines.close();
    stream.destroy();
  }
  return { workingDirectory, firstPrompt };
};

/**
 * Where each session's transcript lies under `projects/`, by session id:
 * every project folder's `<id>.jsonl`, and of a session in two folders the
 * one last written, the copy the SDK lists.
 */
const transcriptPaths = async (directory: string): Promise<ReadonlyMap<string, string>> => {
  const projects = join(directory, "projects");
  const paths = new Map<string, { readonly path: string; readonly written: number }>();
  const folders = await readdir(projects, { withFileTypes: true }).catch(() => []);
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const files = await readdir(join(projects, folder.name)).catch(() => []);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projects, folder.name, file);
      const written = await stat(path).then((found) => found.mtimeMs, () => -1);
      const id = file.slice(0, -".jsonl".length);
      if (written > (paths.get(id)?.written ?? -Infinity)) paths.set(id, { path, written });
    }
  }
  return new Map([...paths].map(([id, { path }]) => [id, path]));
};

/** An SDK instant, milliseconds since the epoch, as ISO 8601. */
const instant = (milliseconds: number): string => new Date(milliseconds).toISOString();

export interface DirectoryListing {
  readonly queue: ConfigDirQueue;
  /** The account's config directory, resolved. */
  readonly directory: string;
  /** The SDK's helper; injected so the adapter hands in the one it imported. */
  readonly listSessions: () => Promise<SDKSessionInfo[]>;
}

/** The sessions of the account's config directory, every project of it, as the listing gives them. */
export const listDirectorySessions = async (read: DirectoryListing): Promise<ProviderSessionInfo[]> => {
  const infos = await read.queue.run(read.directory, () => read.listSessions());
  let paths: Promise<ReadonlyMap<string, string>> | undefined;
  const sessions: ProviderSessionInfo[] = [];
  for (const info of infos) {
    let workingDirectory = info.cwd || null;
    let firstPrompt = info.firstPrompt || null;
    if (workingDirectory === null || firstPrompt === null) {
      const path = (await (paths ??= transcriptPaths(read.directory))).get(info.sessionId);
      const opening: Opening = path === undefined ? { workingDirectory: null, firstPrompt: null } : await readOpening(path);
      workingDirectory ??= opening.workingDirectory;
      firstPrompt ??= opening.firstPrompt;
    }
    if (workingDirectory === null) continue;
    sessions.push({
      providerSessionId: info.sessionId,
      customTitle: info.customTitle || null,
      summary: info.summary || null,
      firstPrompt,
      workingDirectory,
      tag: info.tag || null,
      createdAt: info.createdAt === undefined ? null : instant(info.createdAt),
      lastModified: instant(info.lastModified),
    });
  }
  return sessions;
};
