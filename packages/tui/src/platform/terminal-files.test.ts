import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Snippets, SNIPPETS_FILE } from "../composer/snippets.js";
import { commitTerminalBatch, terminalCompletion } from "./terminal-batch.js";
import { jsonDocuments } from "./json-documents.js";

// Enforce Windows' file-flush access rule even when this regression runs on Unix.
// All other filesystem operations, including SQLite and atomic renames, remain real.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readOnly = new Set<number>();
  return {
    ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      const fd = fs.openSync(...args);
      if (args[1] === "r") readOnly.add(fd);
      return fd;
    },
    fsyncSync: (fd: number) => {
      if (readOnly.has(fd) && !fs.fstatSync(fd).isDirectory()) {
        throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
      }
      fs.fsyncSync(fd);
    },
    closeSync: (fd: number) => { readOnly.delete(fd); fs.closeSync(fd); },
  };
});

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

it("saves and reloads a terminal document when file flushing requires write access", async () => {
  dir = mkdtempSync(join(tmpdir(), "terminal-files-"));
  await jsonDocuments(join(dir, "documents")).set("connections.paired", { local: true });
  expect(await jsonDocuments(join(dir, "documents")).get("connections.paired")).toEqual({ local: true });
});

it("replays a committed terminal batch when file flushing requires write access", async () => {
  dir = mkdtempSync(join(tmpdir(), "terminal-files-"));
  expect(() => commitTerminalBatch(dir, { sourceKey: "source-for-tests",
    snippets: [{ name: "recovered", body: "saved text", updatedAt: 1 }] },
  { afterCommit: () => { throw new Error("interrupted after commit"); } })).toThrow("interrupted after commit");
  expect(terminalCompletion(dir, "source-for-tests")).toEqual(["snippets"]);
  expect((await Snippets.load(join(dir, SNIPPETS_FILE))).get("recovered")?.body).toBe("saved text");
});
