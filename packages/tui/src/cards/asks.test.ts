import type { EnvironmentView, ParkedAsk } from "@agent-harness/client-runtime";
import { PromptOpenedPayload } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { abbreviationOf } from "../rail/badge.js";
import { askRows, asksHeading, decidable, inBulk, parkedSessions } from "./asks.js";

/** The asks card's rows as pure functions: the badge, the countdown's words, and which rows answer in place. */

const view = (environmentId: string, name: string | null, colour: string | null = null) => ({ environmentId, name, colour }) as unknown as EnvironmentView;

const ask = (fields: Partial<ParkedAsk> & Pick<ParkedAsk, "environmentId" | "sessionId" | "promptId">): ParkedAsk => {
  const prompt = PromptOpenedPayload.parse({
    runId: "0199a100-0000-4000-8000-000000000001",
    promptId: fields.promptId,
    kind: fields.kind ?? "permission",
    toolName: "Bash",
    toolCallId: null,
    input: null,
    summary: fields.summary ?? "Bash: rm -rf build",
    blockedPath: null,
    reason: null,
    questions: fields.kind === "question" ? [{ header: "DB", question: "Which database?", options: [], multiSelect: false }] : null,
    plan: null,
    suggestions: [],
    agentId: null,
    denylist: null,
    mode: "acceptEdits",
    ceiling: "bypassPermissions",
    ttlExpiresAt: null,
  });
  return {
    title: "Receipts",
    runId: prompt.runId,
    kind: prompt.kind,
    summary: prompt.summary,
    openedAt: "2026-09-24T00:00:00.000Z",
    sequence: 1,
    prompt,
    ttl: null,
    ...fields,
  };
};

describe("the badge", () => {
  it("takes the first letters of two words, else the first two letters, in capitals", () => {
    expect(abbreviationOf("desk")).toBe("DE");
    expect(abbreviationOf("system server")).toBe("SS");
    expect(abbreviationOf("gaming-pc")).toBe("GP");
    expect(abbreviationOf(null)).toBe("TM");
  });
});

describe("the rows", () => {
  const views = [view("env-a", "desk"), view("env-b", "laptop", "green")];

  it("carry the badge, the session on screen, the kind's word, a question's question and the countdown", () => {
    const rows = askRows(
      [
        ask({ environmentId: "env-a", sessionId: "S-1", promptId: "p-1", ttl: { expiresAt: "2026-09-24T02:00:00.000Z", remainingMs: 7_200_000 } }),
        ask({ environmentId: "env-b", sessionId: "s-2", promptId: "p-2", kind: "question", title: null }),
        ask({ environmentId: "env-b", sessionId: "s-3", promptId: "p-3", kind: "denylist" }),
      ],
      views,
      { environmentId: "env-a", sessionId: "s-1" },
    );
    expect(rows.map((row) => [row.badge.abbreviation, row.title, row.here, row.kindWord, row.detail, row.ttl])).toEqual([
      ["DE", "Receipts", true, "", "Bash: rm -rf build", "2h 0m left"],
      ["LA", "a session", false, "question", "Which database?", undefined],
      ["LA", "Receipts", false, "denylist", "Bash: rm -rf build", undefined],
    ]);
    expect(rows[1]?.badge.colour).toBe("green");
    expect(rows[0]?.key).toBe("env-a s-1 p-1");
    // An environment not listed wears no other environment's badge.
    expect(askRows([ask({ environmentId: "env-gone", sessionId: "s-9", promptId: "p-9" })], views, null)[0]?.badge).toMatchObject({ abbreviation: "??", colour: "gray" });
  });

  it("answer a permission or a denylist prompt in place, bulk only permissions, and open the rest", () => {
    expect(["permission", "denylist", "question", "plan"].map((kind) => [decidable(kind as never), inBulk(kind as never)])).toEqual([
      [true, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
  });

  it("count the prompts in the heading, and name each parked session once", () => {
    expect(asksHeading(1)).toBe("1 prompt is waiting on you");
    expect(asksHeading(3)).toBe("3 prompts are waiting on you");
    const asks = [
      ask({ environmentId: "env-a", sessionId: "s-1", promptId: "p-1" }),
      ask({ environmentId: "env-a", sessionId: "S-1", promptId: "p-2" }),
      ask({ environmentId: "env-b", sessionId: "s-1", promptId: "p-3" }),
    ];
    expect(parkedSessions(asks)).toEqual([
      { environmentId: "env-a", sessionId: "s-1" },
      { environmentId: "env-b", sessionId: "s-1" },
    ]);
  });
});
