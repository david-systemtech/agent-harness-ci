import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCommand, isMethodName, registry } from "@agent-harness/contracts";
import { createRuntime } from "@agent-harness/client-runtime";
import { inMemoryPlatform, manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readLocalTerminalSource } from "../../../environment/src/state-import/terminal-source.js";
import { machinePointedAt } from "../../../environment/src/state-import/source/folders.js";
import { Snippets, SNIPPETS_FILE } from "../composer/snippets.js";
import { PromptHistory, HISTORY_FILE } from "../composer/history.js";
import { jsonDocuments } from "./json-documents.js";
import { AFTER_EDIT_DOCUMENT, terminalCompletion } from "./terminal-batch.js";
import { importTerminalState, type TerminalImportSource } from "./terminal-import.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "terminal-import-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const HELD = "01990000-0000-4000-8000-000000000001";
const UNHELD = "01990000-0000-4000-8000-000000000002";
const source = (): TerminalImportSource => ({ sourceKey: "/fixture", history: { status: "read", records: [
  { ts: 1, text: "held prompt", cwd: "/repo", sessionId: HELD },
  { ts: 2, text: "unheld prompt", cwd: "/repo", sessionId: UNHELD },
] }, snippets: { status: "absent", records: [] }, afterEdit: { status: "read", records: [{ cwd: "/repo", command: "do not execute" }] }, diagnostics: [] });
const onEnvironment = () => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "local", sessions: [{ id: HELD }] },
    { name: "away", reach: "unpaired", sessions: [{ id: HELD }, { id: UNHELD }] }] });
  const platform = inMemoryPlatform({ clock, fetch: world.fetch, webSocket: world.webSocket, ...(world.grant ? { grant: world.grant } : {}), kind: "tui" });
  return { world, runtime: createRuntime(platform) };
};

it("retains only held Session associations and leaves imported commands inert", async () => {
  const { world, runtime } = onEnvironment();
  try {
    await runtime.start();
    expect(await importTerminalState({ source: source(), stateDir: dir, runtime })).toEqual([]);
    const history = await PromptHistory.load(join(dir, HISTORY_FILE));
    expect(history.recent({ kind: "session", sessionId: HELD })).toEqual(["held prompt"]);
    expect(history.recent({ kind: "session", sessionId: UNHELD })).toEqual([]);
    expect(history.recent({ kind: "all" })).toEqual(["unheld prompt", "held prompt"]);
    expect(await jsonDocuments(join(dir, "documents")).get(AFTER_EDIT_DOCUMENT)).toEqual({ "/repo": "do not execute" });
    expect(world.environment("desk").wire.server.received().filter((frame) =>
      frame.type === "request" && isMethodName(frame.method) && isCommand(registry[frame.method]))).toEqual([]);
  } finally { await runtime.close(); }
});

it("persists valid partial records, marks independent successes, and retries after restart without duplicates", async () => {
  const { runtime } = onEnvironment();
  try {
    await runtime.start();
    const partial: TerminalImportSource = { ...source(), history: { ...source().history, status: "partial" },
      snippets: { status: "failed", records: [] }, diagnostics: [
        { part: "history", reason: "invalid_record", count: 1 }, { part: "snippets", reason: "malformed", count: 1 },
      ] };
    expect(await importTerminalState({ source: partial, stateDir: dir, runtime })).toHaveLength(2);
    expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(2);
    expect(terminalCompletion(dir, "/fixture")).toEqual(["afterEdit"]);
    const documents = jsonDocuments(join(dir, "documents"));
    await documents.set(AFTER_EDIT_DOCUMENT, { "/repo": "local edit" });
    await runtime.close();
    const restarted = onEnvironment().runtime;
    try {
      await restarted.start();
      await importTerminalState({ source: source(), stateDir: dir, runtime: restarted });
      await importTerminalState({ source: source(), stateDir: dir, runtime: restarted });
      expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(2);
      expect(await documents.get(AFTER_EDIT_DOCUMENT)).toEqual({ "/repo": "local edit" });
      expect(terminalCompletion(dir, "/fixture")).toEqual(["afterEdit", "history", "snippets"]);
    } finally { await restarted.close(); }
  } finally { await runtime.close(); }
});

it("keeps valid prompt text but drops associations when the selected Environment is not local", async () => {
  const { world, runtime } = onEnvironment();
  try {
    await runtime.start();
    await runtime.connections.add({ link: world.environment("away").wire.link });
    await importTerminalState({ source: source(), stateDir: dir, runtime, environment: "away" });
    const history = await PromptHistory.load(join(dir, HISTORY_FILE));
    expect(history.size).toBe(2);
    expect(history.recent({ kind: "session", sessionId: HELD })).toEqual([]);
  } finally { await runtime.close(); }
});

it("leaves history retryable when holdings cannot be read, while committing other valid parts", async () => {
  const { world, runtime } = onEnvironment();
  try {
    await runtime.start();
    world.environment("desk").wire.answer("sessions.list", () => ({ error: { code: "internal", message: "fixture failure", data: {} } }));
    expect(await importTerminalState({ source: source(), stateDir: dir, runtime })).toContain(
      "Terminal import: history: local Environment unavailable; retry with --import-terminal-state.");
    expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(0);
    expect(terminalCompletion(dir, "/fixture")).toEqual(["snippets", "afterEdit"]);
  } finally { await runtime.close(); }
});

it.each(["beforeCommit", "afterCommit", "write"] as const)("recovers from %s write failure on the next launch without duplicate history", async (point) => {
  const { runtime } = onEnvironment();
  try {
    await runtime.start();
    await expect(importTerminalState({ source: source(), stateDir: dir, runtime,
      faults: { [point]: () => { throw new Error("fixture interruption"); } } })).rejects.toThrow("fixture interruption");
    expect(terminalCompletion(dir, "/fixture")).toEqual(point === "beforeCommit" ? [] : ["history", "snippets", "afterEdit"]);
    await importTerminalState({ source: source(), stateDir: dir, runtime });
    expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(2);
  } finally { await runtime.close(); }
});

it("reads partial fixture stores independently and completes them once repaired through the canonical source", async () => {
  const fixture = join(dir, "source");
  await mkdir(fixture);
  await writeFile(join(fixture, "history.jsonl"), 'broken line\n' + JSON.stringify({ ts: 1, text: "valid", cwd: "/repo" }) + '\n');
  await writeFile(join(fixture, "snippets.json"), JSON.stringify({ version: 1, snippets: [
    { name: "keep", body: "source" }, { name: "new", body: "$1" }, { name: "Invalid Name", body: "invalid" },
  ] }));
  await writeFile(join(fixture, "preferences.json"), JSON.stringify({ version: 1, preferences: {
    afterEdit: { "/repo": "inert", "/invalid": 12 }, pinned: [HELD], drafts: { [HELD]: "do not carry" },
    composerSeed: "do not carry", sessionModels: { [HELD]: "do not carry" }, layout: "do not carry", fileFrecency: "do not carry",
  } }));
  const stateDir = join(dir, "target");
  const local = await Snippets.load(join(stateDir, SNIPPETS_FILE));
  local.set("keep", "local", 10);
  await local.flush();
  const { runtime } = onEnvironment();
  const read = async (terminalFolder: string) => {
    const result = await readLocalTerminalSource(machinePointedAt({ terminalFolder, home: join(dir, "home") }));
    if (!result) throw new Error("fixture not detected");
    return result;
  };
  try {
    await runtime.start();
    const messages = await importTerminalState({ source: await read(fixture), stateDir, runtime });
    expect(messages).toHaveLength(3);
    expect(terminalCompletion(stateDir, fixture)).toEqual([]);
    expect((await Snippets.load(join(stateDir, SNIPPETS_FILE))).list()).toEqual([
      { name: "keep", body: "local", updatedAt: 10 }, { name: "new", body: "$1", updatedAt: 0 },
    ]);
    expect(await jsonDocuments(join(stateDir, "documents")).get(AFTER_EDIT_DOCUMENT)).toEqual({ "/repo": "inert" });
    expect(await readdir(join(stateDir, "documents"))).toEqual([`${AFTER_EDIT_DOCUMENT}.json`]);
    await writeFile(join(fixture, "history.jsonl"), JSON.stringify({ ts: 1, text: "valid", cwd: "/repo" }) + '\n');
    await writeFile(join(fixture, "snippets.json"), JSON.stringify({ version: 1, snippets: [] }));
    await writeFile(join(fixture, "preferences.json"), JSON.stringify({ version: 1, preferences: { afterEdit: {} } }));
    const alias = join(dir, "alias");
    await symlink(fixture, alias, "dir");
    expect(await importTerminalState({ source: await read(alias), stateDir, runtime })).toEqual([]);
    expect(terminalCompletion(stateDir, fixture)).toEqual(["history", "snippets", "afterEdit"]);
    expect((await PromptHistory.load(join(stateDir, HISTORY_FILE))).size).toBe(1);
  } finally { await runtime.close(); }
});

it("uses the screen's local fallback when an unknown Environment name was requested", async () => {
  const { runtime } = onEnvironment();
  try {
    await runtime.start();
    await importTerminalState({ source: source(), stateDir: dir, runtime, environment: "unknown" });
    expect((await PromptHistory.load(join(dir, HISTORY_FILE))).recent({ kind: "session", sessionId: HELD })).toEqual(["held prompt"]);
  } finally { await runtime.close(); }
});
