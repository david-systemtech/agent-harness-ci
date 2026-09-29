import type { RunSummary } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { endWords, formatDuration, turnFacts } from "./format.js";

/** The numbers and words a transcript prints (docs/specs/tui.md, "Testing Decisions": the fold's pure helpers). */

describe("formatDuration", () => {
  it("never says 60 seconds: a duration that rounds up to a minute says the minute", () => {
    expect(formatDuration(900)).toBe("900ms");
    expect(formatDuration(4200)).toBe("4.2s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(59_500)).toBe("1m 0s");
    expect(formatDuration(119_500)).toBe("2m 0s");
    expect(formatDuration(61_000)).toBe("1m 1s");
  });
});

describe("a finished turn's cost line", () => {
  const ended = (more: Partial<RunSummary>): RunSummary => ({
    runId: "0199a100-0000-4000-8000-000000000001",
    state: "ended",
    origin: "client",
    accountId: "account-1",
    model: "claude-fake",
    effort: null,
    mode: { requested: null, effective: "acceptEdits", clamped: false },
    promptMessageId: null,
    queuedMessageIds: [],
    startedAt: "2026-09-25T10:00:00.000Z",
    endedAt: "2026-09-25T10:00:05.000Z",
    reason: "completed",
    cause: null,
    error: null,
    usage: null,
    durationMs: 5000,
    ...more,
  });

  it("says the time, the tokens in (cache reads and writes counted) and out, and the dollars only when the provider said", () => {
    const usage = [
      { model: "a", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 100, costUsd: 0.01, contextWindow: null },
      { model: "b", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, contextWindow: null },
    ];
    expect(turnFacts(ended({ durationMs: 12_300, usage }))).toEqual(["12s", "4.1k in", "205 out", "$0.012"]);
    expect(turnFacts(ended({ usage: usage.map((model) => ({ ...model, costUsd: null })) }))).toEqual(["5.0s", "4.1k in", "205 out"]);
    expect(turnFacts(ended({ usage: null }))).toEqual(["5.0s"]);
  });

  it("says how a run that did not complete ended", () => {
    expect(endWords(ended({ reason: "interrupted", cause: "user" }))).toBe("Interrupted");
    expect(endWords(ended({ reason: "interrupted", cause: "read-now" }))).toBe("Interrupted to read the queue");
    expect(endWords(ended({ reason: "error" }))).toBe("Error");
  });
});
