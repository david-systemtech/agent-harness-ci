import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PromptHistory, HISTORY_FILE } from "../composer/history.js";
import { Snippets, SNIPPETS_FILE } from "../composer/snippets.js";
import { jsonDocuments } from "./json-documents.js";
import { TERMINAL_JOURNAL } from "./terminal-files.js";
import { commitTerminalBatch, terminalCompletion, AFTER_EDIT_DOCUMENT } from "./terminal-batch.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "terminal-batch-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("commits local data with completion and preserves existing names and documents", async () => {
  const history = await PromptHistory.load(join(dir, HISTORY_FILE));
  history.append({ ts: 2, text: "local", cwd: "/repo" });
  await history.flush();
  const snippets = await Snippets.load(join(dir, SNIPPETS_FILE));
  snippets.set("keep", "local", 2);
  await snippets.flush();
  const documents = jsonDocuments(join(dir, "documents"));
  await documents.set("connections.paired", { local: true });
  await documents.set(AFTER_EDIT_DOCUMENT, { "/repo": "local command" });
  commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 1, text: "imported", cwd: "/repo" }],
    snippets: [{ name: "keep", body: "source", updatedAt: 1 }, { name: "new", body: "$1", updatedAt: 1 }],
    afterEdit: [{ cwd: "/repo", command: "source" }, { cwd: "/other", command: "inert text" }] });
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).recent({ kind: "all" })).toEqual(["local", "imported"]);
  expect((await Snippets.load(join(dir, SNIPPETS_FILE))).list()).toEqual([
    { name: "keep", body: "local", updatedAt: 2 }, { name: "new", body: "$1", updatedAt: 1 }]);
  expect(await documents.get(AFTER_EDIT_DOCUMENT)).toEqual({ "/repo": "local command", "/other": "inert text" });
  expect(await documents.get("connections.paired")).toEqual({ local: true });
  expect(terminalCompletion(dir, "/source")).toEqual(["history", "snippets", "afterEdit"]);
});

it("enforces history bounds when an ordinary writer loaded before a batch", async () => {
  const writer = await PromptHistory.load(join(dir, HISTORY_FILE));
  commitTerminalBatch(dir, { sourceKey: "/source", history: Array.from({ length: 4000 }, (_, ts) => ({ ts, text: `entry ${ts}`, cwd: "/repo" })) });
  writer.append({ ts: 4001, text: "concurrent append", cwd: "/repo" });
  await writer.flush();
  const restarted = await PromptHistory.load(join(dir, HISTORY_FILE));
  expect(restarted.size).toBe(2000);
  expect(restarted.recent({ kind: "all" })[0]).toBe("concurrent append");
});

it("rolls back a pre-commit interruption and permits retry", async () => {
  const history = await PromptHistory.load(join(dir, HISTORY_FILE));
  history.append({ ts: 1, text: "prior", cwd: "/repo" });
  await history.flush();
  const batch = { sourceKey: "/source", history: [{ ts: 2, text: "new", cwd: "/repo" }] };
  expect(() => commitTerminalBatch(dir, batch, { beforeCommit: () => { throw new Error("interrupted"); } })).toThrow("interrupted");
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).recent({ kind: "all" })).toEqual(["prior"]);
  expect(terminalCompletion(dir, "/source")).toEqual([]);
  commitTerminalBatch(dir, batch);
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(2);
});

it.each(["afterCommit", "write", "rename", "afterInstall"] as const)("recovers a committed batch after %s failure before any ordinary read or edit", async (point) => {
  const batch = { sourceKey: "/source", history: [{ ts: 1, text: "new", cwd: "/repo" }],
    snippets: [{ name: "new", body: "new body", updatedAt: 1 }], afterEdit: [{ cwd: "/repo", command: "do not execute" }] };
  expect(() => commitTerminalBatch(dir, batch, { [point]: () => { throw new Error("failed persistence"); } })).toThrow("failed persistence");
  // Documents can be the first store read on restart: it must recover all three parts.
  expect(await jsonDocuments(join(dir, "documents")).get(AFTER_EDIT_DOCUMENT)).toEqual({ "/repo": "do not execute" });
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).recent({ kind: "all" })).toEqual(["new"]);
  expect((await Snippets.load(join(dir, SNIPPETS_FILE))).get("new")?.body).toBe("new body");
  expect(terminalCompletion(dir, "/source")).toEqual(["history", "snippets", "afterEdit"]);
  commitTerminalBatch(dir, batch);
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(1);
});

it("preserves queued ordinary edits from two stale writers around a batch", async () => {
  const a = await PromptHistory.load(join(dir, HISTORY_FILE));
  const b = await PromptHistory.load(join(dir, HISTORY_FILE));
  const snippetsA = await Snippets.load(join(dir, SNIPPETS_FILE));
  const snippetsB = await Snippets.load(join(dir, SNIPPETS_FILE));
  a.append({ ts: 1, text: "first", cwd: "/repo" });
  snippetsA.set("before", "ordinary", 1);
  await Promise.all([a.flush(), snippetsA.flush()]);
  commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 2, text: "middle", cwd: "/repo" }],
    snippets: [{ name: "before", body: "source", updatedAt: 2 }, { name: "imported", body: "source", updatedAt: 2 }] });
  b.append({ ts: 3, text: "last", cwd: "/repo" });
  snippetsB.set("after", "ordinary", 3);
  await Promise.all([b.flush(), snippetsB.flush()]);
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).recent({ kind: "all" })).toEqual(["last", "middle", "first"]);
  expect((await Snippets.load(join(dir, SNIPPETS_FILE))).list().map(({ name, body }) => [name, body])).toEqual([
    ["after", "ordinary"], ["before", "ordinary"], ["imported", "source"],
  ]);
});

it("keeps distinct timestamp/text occurrences while bounding an oversized batch", async () => {
  const history = Array.from({ length: 4001 }, (_, ts) => ({ ts, text: "same text", cwd: "/repo" }));
  commitTerminalBatch(dir, { sourceKey: "/source", history });
  const restarted = await PromptHistory.load(join(dir, HISTORY_FILE));
  expect(restarted.size).toBe(2000);
  expect(restarted.search("same", { kind: "all" })).toEqual([{ text: "same text", cwd: "/repo", ts: 4000, index: 0 }]);
});

it("marks only supplied successful parts, independently by source", () => {
  commitTerminalBatch(dir, { sourceKey: "/one", snippets: [] });
  commitTerminalBatch(dir, { sourceKey: "/two", history: [] });
  expect(terminalCompletion(dir, "/one")).toEqual(["snippets"]);
  expect(terminalCompletion(dir, "/two")).toEqual(["history"]);
  commitTerminalBatch(dir, { sourceKey: "/one", history: [] });
  expect(terminalCompletion(dir, "/one")).toEqual(["snippets", "history"]);
});

const tsx = createRequire(import.meta.url).resolve("tsx");
const runNode = promisify(execFile);
const batchModule = join(import.meta.dirname, "terminal-batch.ts");

it.each(["beforeCommit", "afterCommit", "afterInstall"] as const)("recovers after a process exits at %s without leaving a stale lock", async (point) => {
  const script = join(dir, "crash.mts");
  await writeFile(script, `
    import { commitTerminalBatch } from ${JSON.stringify(batchModule)};
    commitTerminalBatch(process.argv[2], { sourceKey: "/source", history: [{ ts: 1, text: "new", cwd: "/repo" }], snippets: [] },
      { ${point}: () => process.exit(7) });
  `);
  await expect(runNode(process.execPath, ["--import", tsx, script, dir])).rejects.toMatchObject({ code: 7 });
  const restarted = await PromptHistory.load(join(dir, HISTORY_FILE));
  expect(restarted.size).toBe(point === "beforeCommit" ? 0 : 1);
  expect(terminalCompletion(dir, "/source")).toEqual(point === "beforeCommit" ? [] : ["history", "snippets"]);
  commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 1, text: "new", cwd: "/repo" }], snippets: [] });
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(1);
});

it("serialises overlapping terminal processes without losing ordinary appends or snippets", async () => {
  const script = join(dir, "writer.mts");
  await writeFile(script, `
    import { PromptHistory } from ${JSON.stringify(join(import.meta.dirname, "../composer/history.ts"))};
    import { Snippets } from ${JSON.stringify(join(import.meta.dirname, "../composer/snippets.ts"))};
    import { commitTerminalBatch } from ${JSON.stringify(batchModule)};
    import { join } from "node:path";
    const [dir, kind] = process.argv.slice(2);
    const history = await PromptHistory.load(join(dir, "history.jsonl"));
    const snippets = await Snippets.load(join(dir, "snippets.json"));
    process.stdout.write("ready\\n");
    await new Promise((resolve) => process.stdin.once("data", resolve));
    if (kind === "batch") {
      commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 0, text: "batch", cwd: "/repo" }],
        snippets: [{ name: "batch", body: "imported", updatedAt: 0 }] });
    } else {
      for (let i = 1; i <= 30; i++) {
        history.append({ ts: i, text: kind + i, cwd: "/repo" });
        snippets.set(kind + "-" + i, "ordinary", i);
        await Promise.all([history.flush(), snippets.flush()]);
      }
    }
  `);
  const workers = ["a", "b", "batch"].map((kind) => spawn(process.execPath, ["--import", tsx, script, dir, kind], { stdio: ["pipe", "pipe", "pipe"] }));
  try {
    const exits = workers.map((worker) => once(worker, "exit"));
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      let output = "";
      worker.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.includes("ready\n")) resolve(); });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("writer exited before ready")));
    })));
    for (const worker of workers) worker.stdin.end("go");
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null], [0, null]]);
    expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(61);
    expect((await Snippets.load(join(dir, SNIPPETS_FILE))).list()).toHaveLength(61);
    expect(terminalCompletion(dir, "/source")).toEqual(["history", "snippets"]);
  } finally { for (const worker of workers) worker.kill(); }
});

it.skipIf(process.platform === "win32")("stores its recovery journal, completion and data privately", async () => {
  commitTerminalBatch(dir, { sourceKey: "/source", history: [], snippets: [], afterEdit: [] });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  for (const file of [TERMINAL_JOURNAL, "terminal-import.json", HISTORY_FILE, SNIPPETS_FILE, `documents/${AFTER_EDIT_DOCUMENT}.json`]) {
    expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
  }
});

it("refuses to expose a partial state when restart recovery cannot complete", async () => {
  expect(() => commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 1, text: "new", cwd: "/repo" }], snippets: [] }, {
    afterCommit: () => { mkdirSync(join(dir, SNIPPETS_FILE)); throw new Error("interrupted"); },
  })).toThrow("interrupted");
  await expect(PromptHistory.load(join(dir, HISTORY_FILE))).rejects.toThrow("recovery failed");
  expect(() => terminalCompletion(dir, "/source")).toThrow("recovery failed");
  await rm(join(dir, SNIPPETS_FILE), { recursive: true });
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(1);
  expect(terminalCompletion(dir, "/source")).toEqual(["history", "snippets"]);
});

it("refuses corrupt completion metadata instead of reporting an unrecorded success", async () => {
  await writeFile(join(dir, "terminal-import.json"), "[]");
  expect(() => commitTerminalBatch(dir, { sourceKey: "/source", history: [{ ts: 1, text: "new", cwd: "/repo" }] })).toThrow("completion metadata");
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(0);
});

it("retries unmarked history by timestamp/text occurrence without losing local edits", async () => {
  const batch = { sourceKey: "/source", history: [
    { ts: 1, text: "repeat", cwd: "/repo" },
    { ts: 2, text: "repeat", cwd: "/repo" },
    { ts: 2, text: "repeat", cwd: "/repo" },
  ], completed: [] };
  commitTerminalBatch(dir, batch);
  expect(terminalCompletion(dir, "/source")).toEqual([]);
  const local = await PromptHistory.load(join(dir, HISTORY_FILE));
  local.append({ ts: 3, text: "local edit", cwd: "/repo" });
  await local.flush();
  commitTerminalBatch(dir, { ...batch, completed: ["history"] as const });
  expect((await PromptHistory.load(join(dir, HISTORY_FILE))).size).toBe(3);
  expect(terminalCompletion(dir, "/source")).toEqual(["history"]);
});
