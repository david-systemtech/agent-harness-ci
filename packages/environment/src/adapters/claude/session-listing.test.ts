import { randomUUID } from "node:crypto";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotOf } from "../../../test/accounts.js";
import { useCleanups } from "../../../test/cleanups.js";
import type { ProviderSessionInfo } from "../../adapter/contract.js";
import { createClaudeAdapter } from "./index.js";

/**
 * The Claude adapter's session listing (#578; ADR 0021) against a fixture
 * config directory, through the pinned SDK's own `listSessions`, unmocked:
 * every project folder of the directory, each session with what the SDK's
 * info says of it, and a transcript's first lines read only where that info
 * lacks the working directory or the first prompt. Orphaned and superseded
 * transcripts are left out, and nothing in the directory is created,
 * linked or deleted.
 */

const { tempDir } = useCleanups();

const WRITTEN = new Date("2026-08-03T17:30:00.000Z");

/** One JSONL line. */
const line = (record: Record<string, unknown>): string => `${JSON.stringify(record)}\n`;

/** A user record of the CLI's transcript: its prompt, where it ran, when. */
const user = (sessionId: string, cwd: string, content: unknown, timestamp = "2026-08-01T09:00:00.000Z", uuid = randomUUID()) =>
  line({ parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.0", gitBranch: "main", type: "user", message: { role: "user", content }, uuid, timestamp });

/** The assistant's answer to it. */
const assistant = (sessionId: string, cwd: string, text: string, timestamp = "2026-08-01T09:01:00.000Z") =>
  line({
    parentUuid: randomUUID(),
    isSidechain: false,
    cwd,
    sessionId,
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
    uuid: randomUUID(),
    timestamp,
  });

/** Writes a transcript into a project folder of `directory`, last written at `WRITTEN`; answers its session id. */
const transcript = (directory: string, project: string, lines: (id: string) => string, id: string = randomUUID()): string => {
  const folder = join(directory, "projects", project);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${id}.jsonl`);
  writeFileSync(path, lines(id));
  utimesSync(path, WRITTEN, WRITTEN);
  return id;
};

describe("the Claude adapter's session listing", () => {
  it("lists every project's sessions from the SDK's info, reads first lines only for what that info lacks, and leaves out orphaned and superseded transcripts", async () => {
    const directory = join(tempDir(), ".claude");
    const repo = "/work/agent-harness";
    const scratch = "/home/david/scratch";
    const renamed = transcript(directory, "-work-agent-harness", (id) =>
      [user(id, repo, "Fix the receipts"), assistant(id, repo, "Fixed."), line({ type: "custom-title", customTitle: "Receipts fix", sessionId: id })].join(""),
    );
    const archived = transcript(directory, "-work-agent-harness", (id) =>
      [user(id, repo, "Old work"), assistant(id, repo, "Done."), line({ type: "tag", tag: "archived", sessionId: id })].join(""),
    );
    // The scheduler's firing: the SDK's first prompt passes over a prompt that opens with a tag, so its first line is read.
    const opening = '<scheduled-task name="nightly" file="/home/david/.claude/scheduled-tasks/nightly.md">\nRun the nightly check\n</scheduled-task>';
    const fired = transcript(directory, "-work-agent-harness", (id) =>
      [user(id, repo, opening), assistant(id, repo, "All green."), line({ type: "ai-title", aiTitle: "Nightly check", sessionId: id })].join(""),
    );
    // Its working directory lies past the SDK's first 64 kB: a large record opens it, so its first lines are read.
    const deep = transcript(directory, "-work-agent-harness", (id) =>
      [
        line({ type: "file-history-snapshot", messageId: randomUUID(), snapshot: { blob: "x".repeat(70_000) }, isSnapshotUpdate: false }),
        user(id, scratch, [{ type: "text", text: "Tidy the scratch directory" }]),
        assistant(id, scratch, "Tidied."),
        line({ type: "ai-title", aiTitle: "Tidy up", sessionId: id }),
      ].join(""),
    );
    // Superseded: it was continued in another session whose transcript is there.
    const successor = randomUUID();
    transcript(directory, "-work-agent-harness", (id) =>
      [user(id, repo, "Start the migration"), assistant(id, repo, "Started."), line({ type: "continued-in", continuedInSessionId: successor, sessionId: id })].join(""),
    );
    transcript(directory, "-work-agent-harness", (id) => [user(id, repo, "Go on with the migration"), assistant(id, repo, "Went on.")].join(""), successor);
    // A subagent's transcript at the top of a project, and one in its session's folder.
    transcript(directory, "-work-agent-harness", (id) => line({ parentUuid: null, isSidechain: true, cwd: repo, sessionId: id, type: "user", message: { role: "user", content: "Explore" } }));
    mkdirSync(join(directory, "projects", "-work-agent-harness", renamed, "subagents"), { recursive: true });
    writeFileSync(join(directory, "projects", "-work-agent-harness", renamed, "subagents", "agent-a1.jsonl"), user(renamed, repo, "Explore the tree"));
    // Orphaned: a summary with nothing of its conversation left beside it.
    transcript(directory, "-work-agent-harness", () => line({ type: "summary", summary: "A summary of nothing here", leafUuid: randomUUID() }));
    // Another project, and a file that names no session.
    const elsewhere = transcript(directory, "-home-david-scratch", (id) => [user(id, scratch, "Sketch the card"), assistant(id, scratch, "Sketched.")].join(""));
    writeFileSync(join(directory, "projects", "-home-david-scratch", "notes.jsonl"), user("notes", scratch, "Not a session"));
    writeFileSync(join(directory, "settings.json"), '{"theme":"dark"}\n');
    const before = snapshotOf(directory);
    const adapter = createClaudeAdapter({ executablePath: null, hostEnv: { PATH: "/usr/bin", HOME: tempDir() }, diagnostic: () => undefined });

    const listed = await adapter.listSessions({ id: "claude-max", directory });

    const at = WRITTEN.toISOString();
    const session = (fields: Partial<ProviderSessionInfo> & Pick<ProviderSessionInfo, "providerSessionId">): ProviderSessionInfo => ({
      customTitle: null,
      summary: null,
      firstPrompt: null,
      workingDirectory: repo,
      tag: null,
      createdAt: "2026-08-01T09:00:00.000Z",
      lastModified: at,
      ...fields,
    });
    const byId = (a: ProviderSessionInfo, b: ProviderSessionInfo) => a.providerSessionId.localeCompare(b.providerSessionId);
    expect([...listed].sort(byId)).toEqual(
      [
        session({ providerSessionId: renamed, customTitle: "Receipts fix", summary: "Receipts fix", firstPrompt: "Fix the receipts" }),
        session({ providerSessionId: archived, summary: "Old work", firstPrompt: "Old work", tag: "archived" }),
        session({ providerSessionId: fired, customTitle: "Nightly check", summary: "Nightly check", firstPrompt: opening.replaceAll("\n", " ") }),
        session({ providerSessionId: deep, customTitle: "Tidy up", summary: "Tidy up", firstPrompt: "Tidy the scratch directory", workingDirectory: scratch, createdAt: null }),
        session({ providerSessionId: successor, summary: "Go on with the migration", firstPrompt: "Go on with the migration" }),
        session({ providerSessionId: elsewhere, summary: "Sketch the card", firstPrompt: "Sketch the card", workingDirectory: scratch }),
      ].sort(byId),
    );
    expect(snapshotOf(directory)).toEqual(before);
    expect(adapter.descriptor.sessionListing).toBe(true);
  });
});
