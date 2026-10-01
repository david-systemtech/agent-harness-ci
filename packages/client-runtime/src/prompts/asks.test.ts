import { PromptOpenedPayload, type PromptKind } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { ParkedAsk } from "../projections/runs.js";
import { askDetail, bulkAsks, bulkQuestion, decidable, inBulk } from "./asks.js";

/** The parked asks' rules as pure functions: which rows answer in place, which Allow all takes, and what a row asks. */

const ask = (kind: PromptKind, promptId: string, summary = "Bash: rm -rf build"): ParkedAsk => {
  const prompt = PromptOpenedPayload.parse({
    runId: "0199a100-0000-4000-8000-000000000001",
    promptId,
    kind,
    toolName: "Bash",
    toolCallId: null,
    input: null,
    summary,
    blockedPath: null,
    reason: null,
    questions: kind === "question" ? [{ header: "DB", question: "Which database?", options: [], multiSelect: false }] : null,
    plan: null,
    suggestions: [],
    agentId: null,
    denylist: null,
    mode: "acceptEdits",
    ceiling: "bypassPermissions",
    ttlExpiresAt: null,
  });
  return { environmentId: "env-a", sessionId: "s-1", title: "Receipts", runId: prompt.runId, promptId, kind, summary, openedAt: "2026-09-24T00:00:00.000Z", sequence: 1, prompt, ttl: null };
};

describe("the rows", () => {
  it("answer a permission or a denylist prompt in place, bulk only permissions, and open the rest", () => {
    expect((["permission", "denylist", "question", "plan"] as const).map((kind) => [decidable(kind), inBulk(kind)])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
  });

  it("ask a question's first question, and every other prompt's summary", () => {
    expect(askDetail(ask("question", "p-1"))).toBe("Which database?");
    expect(askDetail(ask("permission", "p-2", "Bash: git push"))).toBe("Bash: git push");
    expect(askDetail(ask("plan", "p-3", "Plan: split the parser"))).toBe("Plan: split the parser");
  });
});

describe("Allow all and Deny all", () => {
  it("take every permission row, never a denylist row, and only when there are two or more", () => {
    const listed = [ask("permission", "p-1"), ask("denylist", "p-2"), ask("question", "p-3"), ask("permission", "p-4")];
    expect(bulkAsks(listed).map((row) => row.promptId)).toEqual(["p-1", "p-4"]);
    expect(bulkAsks([ask("permission", "p-1"), ask("denylist", "p-2")])).toEqual([]);
    expect(bulkAsks([])).toEqual([]);
  });

  it("ask once, counting the rows", () => {
    expect(bulkQuestion("allow", 3)).toBe("Allow all 3 permissions once?");
    expect(bulkQuestion("deny", 2)).toBe("Deny all 2 permissions?");
  });
});
