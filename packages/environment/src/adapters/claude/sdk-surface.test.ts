import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { detectFeatures } from "./process.js";

/**
 * The pinned SDK's undeclared surface, on a real `query()` (not the mock the
 * other adapter tests use): the adapter reaches `interrupt({cancelQueued})`
 * and `cancelAsyncMessage` through casts, since 0.3.281 has both at run
 * time and declares neither. If an SDK bump removes one, this fails before
 * the adapter silently degrades. The executable is a Node script that reads
 * its input and says nothing, so no Claude binary runs and nothing reaches
 * the network.
 */

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("the pinned SDK's query object", () => {
  it("has the cancel-by-id control and an interrupt that takes options", () => {
    const root = mkdtempSync(join(tmpdir(), "claude-surface-"));
    roots.push(root);
    const silent = join(root, "silent.mjs");
    writeFileSync(silent, "process.stdin.resume();\n");
    const abort = new AbortController();
    const idle: AsyncIterable<SDKUserMessage> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve) => abort.signal.addEventListener("abort", () => resolve({ value: undefined, done: true }))) }),
    };
    const made = query({ prompt: idle, options: { pathToClaudeCodeExecutable: silent, abortController: abort, env: { PATH: process.env["PATH"] ?? "" }, cwd: root } });
    try {
      const bag = made as unknown as Record<string, unknown>;
      expect(typeof bag["cancelAsyncMessage"]).toBe("function");
      expect(typeof bag["interrupt"]).toBe("function");
      expect((bag["interrupt"] as (...args: unknown[]) => unknown).length).toBeGreaterThanOrEqual(1);
      expect(detectFeatures(made, ["interrupt_receipt_v1", "interrupt_cancel_queued_v1"])).toEqual({ cancelQueued: true, cancelById: true });
      expect(detectFeatures(made, ["interrupt_receipt_v1"])).toEqual({ cancelQueued: false, cancelById: true });
    } finally {
      abort.abort();
      made.close();
    }
  });
});
