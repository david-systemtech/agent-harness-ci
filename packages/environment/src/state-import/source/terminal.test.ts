import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { machinePointedAt } from "./folders.js";
import { readLocalTerminalSource } from "./terminal.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "terminal-source-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const machine = () => machinePointedAt({ terminalFolder: dir, home: join(dir, "home") });

it("normalises audited writer shapes without exposing other preferences or unknown fields", async () => {
  await writeFile(join(dir, "history.jsonl"), [
    { ts: 10, text: "first\nsecond", cwd: "/repo", sessionId: "session", credential: "token-for-tests" },
    { ts: 10, text: "first\nsecond", cwd: "/repo" },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  await writeFile(join(dir, "snippets.json"), JSON.stringify({ version: 1, snippets: [{ name: "fix-tests", body: "$1", credential: "token-for-tests" }] }));
  await writeFile(join(dir, "preferences.json"), JSON.stringify({ version: 1, preferences: {
    afterEdit: { "/repo": "echo do not run" }, pinned: ["session"], drafts: [{ sessionId: "session", text: "private draft" }], credential: "token-for-tests",
  } }));
  const source = await readLocalTerminalSource(machine());
  expect(source).toEqual({ sourceKey: dir, history: { status: "read", records: [
    { ts: 10, text: "first\nsecond", cwd: "/repo", sessionId: "session" }, { ts: 10, text: "first\nsecond", cwd: "/repo" },
  ] }, snippets: { status: "read", records: [{ name: "fix-tests", body: "$1", updatedAt: 0 }] },
    afterEdit: { status: "read", records: [{ cwd: "/repo", command: "echo do not run" }] }, diagnostics: [] });
  expect(JSON.stringify(source)).not.toMatch(/credential|token-for-tests|private draft|pinned/);
});

it("reports corrupt entries without quoting them and keeps valid occurrences", async () => {
  await writeFile(join(dir, "history.jsonl"), 'not-json token-for-tests\n' + JSON.stringify({ ts: 1, text: "keep", cwd: "/repo" }) + '\n{"ts":');
  await writeFile(join(dir, "snippets.json"), JSON.stringify({ version: 1, snippets: [
    { name: "Invalid Name", body: "token-for-tests" }, { name: "ok", body: "keep" },
  ] }));
  const source = await readLocalTerminalSource(machine());
  expect(source?.history).toEqual({ status: "partial", records: [{ ts: 1, text: "keep", cwd: "/repo" }] });
  expect(source?.snippets).toEqual({ status: "partial", records: [{ name: "ok", body: "keep", updatedAt: 0 }] });
  expect(source?.afterEdit).toEqual({ status: "absent", records: [] });
  expect(source?.diagnostics).toEqual([{ part: "history", reason: "invalid_record", count: 2 }, { part: "snippets", reason: "invalid_record", count: 1 }]);
  expect(JSON.stringify(source)).not.toContain("token-for-tests");
});

it("fails malformed/unsupported stores independently and retains missing optional stores", async () => {
  await writeFile(join(dir, "snippets.json"), JSON.stringify({ version: 2, snippets: [] }));
  await writeFile(join(dir, "preferences.json"), '{"credential":"token-for-tests",');
  const source = await readLocalTerminalSource(machine());
  expect(source?.history).toEqual({ status: "absent", records: [] });
  expect(source?.snippets).toEqual({ status: "failed", records: [] });
  expect(source?.afterEdit).toEqual({ status: "failed", records: [] });
  expect(source?.diagnostics).toEqual([{ part: "snippets", reason: "unsupported", count: 1 }, { part: "afterEdit", reason: "malformed", count: 1 }]);
});

it("detects no source in an unrelated folder", async () => {
  await writeFile(join(dir, "unrelated.json"), "{}");
  expect(await readLocalTerminalSource(machine())).toBeNull();
});

it("returns scrubbed unreadable diagnostics for a store that cannot be read", async () => {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(dir, "history.jsonl"));
  const source = await readLocalTerminalSource(machine());
  expect(source?.history).toEqual({ status: "failed", records: [] });
  expect(source?.diagnostics).toEqual([{ part: "history", reason: "unreadable", count: 1 }]);
});
