import { choiceRows } from "@agent-harness/client-runtime";
import { PromptOpenedPayload, promptAnswerMisfits } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { cardFor, chosen, denied, lineClosed, lineEntered, lineOpened, lineTyped, moved, ticked, type CardState, type CardStep } from "./prompt.js";

/**
 * The card's state as pure functions: every answer a key makes fits its
 * prompt's kind by the contracts' own rule (`promptAnswerMisfits`), so the
 * environment never refuses one as `invalid_params`.
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

const answerOf = (step: CardStep) => {
  if (step.kind !== "answer") throw new Error(`Expected an answer, got ${step.kind}.`);
  return step.answer;
};

const at = (state: CardState, cursor: number): CardState => ({ ...state, cursor });

describe("an approval", () => {
  it("offers Deny first, so the card's first Enter denies; a permission prompt adds the row for this session, a denylist prompt never", () => {
    const permission = prompt({});
    const denylist = prompt({ kind: "denylist" });
    expect(choiceRows(permission).map((row) => row.kind)).toEqual(["deny", "allow", "session"]);
    expect(choiceRows(denylist).map((row) => row.kind)).toEqual(["deny", "allow"]);
    expect(answerOf(chosen(permission, cardFor("p-1")))).toEqual({ decision: "deny" });
    expect(answerOf(chosen(permission, at(cardFor("p-1"), 1)))).toEqual({ decision: "allow" });
    expect(answerOf(chosen(permission, at(cardFor("p-1"), 2)))).toEqual({ decision: "allow", remember: "session" });
    for (const [kind, cursor] of [
      [permission, 0],
      [permission, 1],
      [permission, 2],
      [denylist, 0],
      [denylist, 1],
    ] as const) {
      expect(promptAnswerMisfits(kind.kind, answerOf(chosen(kind, at(cardFor("p-1"), cursor))))).toEqual([]);
    }
  });

  it("clamps the cursor to the rows rather than wrapping onto them", () => {
    const permission = prompt({});
    expect(moved(permission, cardFor("p-1"), -1).cursor).toBe(0);
    expect(moved(permission, at(cardFor("p-1"), 2), 1).cursor).toBe(2);
    expect(moved(prompt({ kind: "denylist" }), at(cardFor("p-1"), 1), 5).cursor).toBe(1);
  });

  it("sends the note as the answer's message, with a deny on Esc or with the row chosen", () => {
    const permission = prompt({});
    const noted = lineClosed(lineTyped(lineOpened(cardFor("p-1")), { text: "use make clean" }) as CardState);
    expect(noted).toMatchObject({ note: "use make clean", line: null });
    expect(denied(permission, noted)).toEqual({ decision: "deny", message: "use make clean" });
    expect(answerOf(chosen(permission, at(noted, 2)))).toEqual({ decision: "allow", remember: "session", message: "use make clean" });
    // Enter in the note's line keeps it and decides nothing.
    expect(lineEntered(permission, lineOpened(noted))).toEqual({ kind: "state", state: noted });
  });

  it("types at the line: text on one line, a character, a word, or everything rubbed out", () => {
    const open = lineOpened(cardFor("p-1"));
    const typed = lineTyped(open, { text: "use make\nclean" }) as CardState;
    expect(typed.line).toBe("use make clean");
    expect(lineTyped(typed, { rub: "character" })?.line).toBe("use make clea");
    expect(lineTyped(typed, { rub: "word" })?.line).toBe("use make ");
    expect(lineTyped(typed, { rub: "all" })?.line).toBe("");
    expect(lineTyped(cardFor("p-1"), { text: "x" })).toBeUndefined();
  });
});

describe("a plan", () => {
  it("opens on Keep planning, approves with no mode on its first approval, and with the mode an approval names", () => {
    const plan = prompt({ kind: "plan", toolName: "ExitPlanMode", input: null, plan: "1. Read", mode: "plan" });
    expect(choiceRows(plan).map((row) => row.label)).toEqual([
      "Keep planning",
      "Approve · continue in acceptEdits",
      "Approve · continue in auto",
      "Approve · continue in bypassPermissions",
    ]);
    expect(answerOf(chosen(plan, cardFor("p-1")))).toEqual({ decision: "deny" });
    expect(answerOf(chosen(plan, at(cardFor("p-1"), 1)))).toEqual({ decision: "allow" });
    expect(answerOf(chosen(plan, at(cardFor("p-1"), 3)))).toEqual({ decision: "allow", mode: "bypassPermissions" });
    for (const cursor of [0, 1, 2, 3]) expect(promptAnswerMisfits("plan", answerOf(chosen(plan, at(cardFor("p-1"), cursor))))).toEqual([]);
  });

  it("greys the modes above the ceiling the run was resolved under and says so rather than answering", () => {
    const plan = prompt({ kind: "plan", toolName: "ExitPlanMode", input: null, plan: "1. Read", mode: "plan", ceiling: "acceptEdits" });
    expect(choiceRows(plan).filter((row) => row.kind === "approve" && row.above).map((row) => row.label)).toEqual([
      "Approve · continue in auto",
      "Approve · continue in bypassPermissions",
    ]);
    expect(chosen(plan, at(cardFor("p-1"), 2))).toEqual({ kind: "say", line: "auto is above the ceiling acceptEdits this run was resolved under." });
  });
});

describe("a question", () => {
  const question = prompt({
    kind: "question",
    toolName: "AskUserQuestion",
    input: null,
    questions: [
      { header: "Checks", question: "Which checks?", options: ["lint", "types", "tests"].map((label) => ({ label, description: "" })), multiSelect: true },
      { header: "DB", question: "Which database?", options: ["Postgres", "SQLite"].map((label) => ({ label, description: "" })), multiSelect: false },
    ],
  });

  it("ticks several options on a multi-select question and one on a single-select one", () => {
    const first = ticked(question, at(ticked(question, cardFor("p-1")) as CardState, 2)) as CardState;
    expect([...first.ticked]).toEqual([0, 2]);
    expect([...(ticked(question, first) as CardState).ticked]).toEqual([0]);
    const second: CardState = { ...cardFor("p-1"), question: 1 };
    const one = ticked(question, second) as CardState;
    expect([...(ticked(question, at(one, 1)) as CardState).ticked]).toEqual([1]);
    expect(ticked(prompt({}), cardFor("p-1"))).toBeUndefined();
  });

  it("walks the questions, taking what is ticked or else the option under the cursor, and answers them all keyed by their text", () => {
    const first = ticked(question, at(ticked(question, cardFor("p-1")) as CardState, 2)) as CardState;
    const next = chosen(question, first);
    if (next.kind !== "state") throw new Error("Expected the next question.");
    expect(next.state).toMatchObject({ question: 1, cursor: 0, answers: { "Which checks?": "lint, tests" } });
    expect([...next.state.ticked]).toEqual([]);
    const answer = answerOf(chosen(question, at(next.state, 1)));
    expect(answer).toEqual({ decision: "allow", answers: { "Which checks?": "lint, tests", "Which database?": "SQLite" } });
    expect(promptAnswerMisfits("question", answer)).toEqual([]);
  });

  it("answers a question in the person's own words from the line, and skips it on Esc as a deny with nothing else", () => {
    const second: CardState = { ...cardFor("p-1"), question: 1, answers: { "Which checks?": "lint" } };
    const words = lineTyped(lineOpened(second), { text: "MySQL, sadly" }) as CardState;
    expect(answerOf(lineEntered(question, words))).toEqual({ decision: "allow", answers: { "Which checks?": "lint", "Which database?": "MySQL, sadly" } });
    expect(denied(question, { ...second, note: "ignored" })).toEqual({ decision: "deny" });
    expect(promptAnswerMisfits("question", denied(question, second))).toEqual([]);
  });
});
