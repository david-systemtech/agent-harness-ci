import { describe, expect, it } from "vitest";
import type { SetupResultView, SetupStepView } from "../projections/setup.js";
import { STEP_STATE_WORDS, countsWords, lastGoodWords, setupReachWords, stepLine, stepNote } from "./checklist.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const HOUR = 3_600_000;

const result = (over: Partial<SetupResultView> = {}): SetupResultView => ({
  step: "forges",
  state: "needs-attention",
  reason: "GitHub did not accept the token.",
  failing: [],
  actions: [],
  checkedAt: new Date(NOW.getTime() - 3 * HOUR).toISOString(),
  asked: true,
  ageMs: 3 * HOUR,
  olderThanCadence: false,
  stale: false,
  ...over,
});

const step = (over: Partial<SetupStepView> = {}): SetupStepView => ({
  id: "forges",
  label: "Forges",
  home: "access.forges",
  registered: true,
  skippable: true,
  result: result(),
  pending: false,
  missing: false,
  ...over,
});

describe("Set up's shared words (setup-copy.md §3, §4.5)", () => {
  it("names each state in a word a person knows", () => {
    expect(STEP_STATE_WORDS).toEqual({ done: "Done", "needs-attention": "Needs a fix", skipped: "Not set up", pending: "Checking" });
  });

  it("says a step's reason on its line, and when it was checked on a second, muted line", () => {
    expect([stepLine(step(), NOW), stepNote(step(), NOW, "desk")]).toEqual(["GitHub did not accept the token.", undefined]);
    const old = step({ result: result({ olderThanCadence: true }) });
    expect([stepLine(old, NOW), stepNote(old, NOW, "desk")]).toEqual(["GitHub did not accept the token.", "Last checked 3 h ago."]);
  });

  it("says a result that may not hold now may be out of date, naming the computer that cannot be reached", () => {
    const stale = step({ result: result({ stale: true, olderThanCadence: true }) });
    expect([stepLine(stale, NOW), stepNote(stale, NOW, "desk")]).toEqual(["GitHub did not accept the token.", "This may be out of date: desk cannot be reached."]);
  });

  it("says a step being checked, or never checked, with what to do and no second line", () => {
    expect([stepLine(step({ pending: true }), NOW), stepNote(step({ pending: true }), NOW, "desk")]).toEqual(["Checking…", undefined]);
    expect([stepLine(step({ result: null }), NOW), stepNote(step({ result: null }), NOW, "desk")]).toEqual(["Not checked yet. Choose Check again.", undefined]);
  });

  it("says when it last worked, dated", () => {
    expect(lastGoodWords({ state: "done", checkedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(), reason: "Every forge account is signed in." }, NOW)).toBe(
      "Last time it worked (2 h ago): Every forge account is signed in.",
    );
  });

  it("says why results may not hold now, from this app's side", () => {
    expect(setupReachWords({ status: "reachable" }, "desk")).toBeUndefined();
    expect(setupReachWords({ status: "service-down", since: null, action: "start-service" }, "desk")).toBe("agent-harness is not running on desk. These results are from before it stopped.");
    expect(setupReachWords({ status: "unreachable", phase: "backoff", since: null }, "desk")).toBe("This app has not reached desk yet.");
    expect(setupReachWords({ status: "unreachable", phase: "backoff", since: "2026-10-08T09:14:00.000Z" }, "desk")).toMatch(/^This app cannot reach desk \(since \S+\)\. These results may be out of date\.$/);
  });

  it("counts the steps with a dot between, and says one that needs a fix in the singular", () => {
    expect(countsWords({ registered: 11, done: 8, needsAttention: 1, skipped: 2, attention: ["forges"] })).toBe("8 done · 1 needs a fix · 2 not set up");
    expect(countsWords({ registered: 11, done: 6, needsAttention: 2, skipped: 1, attention: ["forges", "skills"] })).toBe("6 done · 2 need a fix · 1 not set up · 2 checking");
  });
});
