import { PromptOpenedPayload, promptAnswerMisfits } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { buttonRows, choiceRows, joinAnswers, rowAnswer, ttlWords, type RowOutcome } from "./card.js";

/**
 * A parked prompt's card as both renderers draw it: the rows each kind
 * offers, and what each answers, which fits its prompt's kind by the
 * contracts' own rule (`promptAnswerMisfits`), so the environment never
 * refuses one as `invalid_params`.
 */

const prompt = (fields: Partial<PromptOpenedPayload>): PromptOpenedPayload =>
  PromptOpenedPayload.parse({
    runId: "0199a100-0000-4000-8000-000000000001",
    promptId: "p-1",
    kind: "permission",
    toolName: "Bash",
    toolCallId: null,
    input: { command: "rm -rf build" },
    summary: "Bash: rm -rf build",
    blockedPath: null,
    reason: null,
    questions: null,
    plan: null,
    suggestions: [],
    agentId: null,
    denylist: null,
    mode: "acceptEdits",
    ceiling: "bypassPermissions",
    ttlExpiresAt: null,
    ...fields,
  });

const answerOf = (outcome: RowOutcome) => {
  if (outcome.kind !== "answer") throw new Error(`Expected an answer, got ${outcome.kind}.`);
  return outcome.answer;
};

/** What choosing the `at`th row answers. */
const choose = (of: PromptOpenedPayload, at: number, note = "") => rowAnswer(of, choiceRows(of)[at], note);

describe("an approval", () => {
  it("offers Deny first; a permission prompt adds the row for this session, a denylist prompt never", () => {
    const permission = prompt({});
    const denylist = prompt({ kind: "denylist" });
    expect(choiceRows(permission).map((row) => row.label)).toEqual(["Deny", "Allow once", "Allow for this session"]);
    expect(choiceRows(denylist).map((row) => row.label)).toEqual(["Deny", "Allow once"]);
    expect(choiceRows(permission)[2]?.detail).toBe("no more prompts for Bash in this session");
    expect(answerOf(choose(permission, 0))).toEqual({ decision: "deny" });
    expect(answerOf(choose(permission, 1))).toEqual({ decision: "allow" });
    expect(answerOf(choose(permission, 2))).toEqual({ decision: "allow", remember: "session" });
    expect(answerOf(rowAnswer(permission, undefined, ""))).toEqual({ decision: "deny" });
    for (const [of, at] of [
      [permission, 0],
      [permission, 1],
      [permission, 2],
      [denylist, 0],
      [denylist, 1],
    ] as const) {
      expect(promptAnswerMisfits(of.kind, answerOf(choose(of, at)))).toEqual([]);
    }
  });

  it("lays a denylist prompt of a bypassPermissions run out as Deny and Allow once, the allow never remembered (#1820)", () => {
    const denylist = prompt({ kind: "denylist", mode: "bypassPermissions", ceiling: "bypassPermissions" });
    const rows = buttonRows(denylist);
    expect(rows.map((row) => row.label)).toEqual(["Deny", "Allow once"]);
    expect(rows.map((row) => answerOf(rowAnswer(denylist, row, "")))).toEqual([{ decision: "deny" }, { decision: "allow" }]);
  });

  it("lays a permission prompt out with Allow once last, the button Mod+Enter presses", () => {
    expect(buttonRows(prompt({})).map((row) => row.label)).toEqual(["Deny", "Allow for this session", "Allow once"]);
  });

  it("sends the note, trimmed, as the answer's message with whichever row is chosen; blank sends none", () => {
    const permission = prompt({});
    expect(answerOf(choose(permission, 0, "  use make clean "))).toEqual({ decision: "deny", message: "use make clean" });
    expect(answerOf(choose(permission, 2, "use make clean"))).toEqual({ decision: "allow", remember: "session", message: "use make clean" });
    expect(answerOf(choose(permission, 1, "   "))).toEqual({ decision: "allow" });
  });
});

describe("a plan", () => {
  it("offers Keep planning first, approves with no mode on its first approval, and with the mode an approval names", () => {
    const plan = prompt({ kind: "plan", toolName: "ExitPlanMode", input: null, plan: "1. Read", mode: "plan" });
    expect(choiceRows(plan).map((row) => row.label)).toEqual([
      "Keep planning",
      "Approve · continue in acceptEdits",
      "Approve · continue in auto",
      "Approve · continue in bypassPermissions",
    ]);
    expect(answerOf(choose(plan, 0))).toEqual({ decision: "deny" });
    expect(answerOf(choose(plan, 1))).toEqual({ decision: "allow" });
    expect(answerOf(choose(plan, 3))).toEqual({ decision: "allow", mode: "bypassPermissions" });
    for (const at of [0, 1, 2, 3]) expect(promptAnswerMisfits("plan", answerOf(choose(plan, at)))).toEqual([]);
  });

  it("greys the modes above the ceiling the run was resolved under and says so rather than answering", () => {
    const plan = prompt({ kind: "plan", toolName: "ExitPlanMode", input: null, plan: "1. Read", mode: "plan", ceiling: "acceptEdits" });
    expect(choiceRows(plan).filter((row) => row.kind === "approve" && row.above).map((row) => `${row.label}: ${row.detail}`)).toEqual([
      "Approve · continue in auto: above the ceiling acceptEdits",
      "Approve · continue in bypassPermissions: above the ceiling acceptEdits",
    ]);
    expect(choose(plan, 2)).toEqual({ kind: "say", line: "auto is above the ceiling acceptEdits this run was resolved under." });
  });
});

describe("a question's answer", () => {
  it("joins what was chosen and said with a comma and a space", () => {
    expect(joinAnswers(["lint", "tests"])).toBe("lint, tests");
    expect(joinAnswers(["Postgres"])).toBe("Postgres");
  });
});

describe("the countdown's words", () => {
  it("says hours and minutes, then minutes and seconds, then seconds, and expiring at zero", () => {
    expect(ttlWords(2 * 3600_000)).toBe("2h 0m left");
    expect(ttlWords(2 * 3600_000 - 1)).toBe("1h 59m left");
    expect(ttlWords(61_000)).toBe("1m 1s left");
    expect(ttlWords(59_999)).toBe("59s left");
    expect(ttlWords(0)).toBe("expiring");
  });
});
