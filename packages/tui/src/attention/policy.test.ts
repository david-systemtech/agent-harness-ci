import { describe, expect, it } from "vitest";
import { titleFor } from "./chrome.js";
import { awayRecap, noticeFor, titleStateOf, type RecapSubject, type RunEnded, type SessionActivity } from "./policy.js";

/**
 * The chrome's decisions: every one of them is about a person who is not
 * looking at the screen, which is why they are worth pinning.
 */

const idle: SessionActivity = { status: "idle", pendingPrompts: 0 };
const ended: SessionActivity = { status: "ended", pendingPrompts: 0 };
const running: SessionActivity = { status: "running", pendingPrompts: 0 };
const starting: SessionActivity = { status: "starting", pendingPrompts: 0 };
const asking: SessionActivity = { status: "parked", pendingPrompts: 1 };

describe("titleStateOf", () => {
  it("is ready when nothing runs, and for no sessions at all", () => {
    expect(titleStateOf([])).toEqual({ state: "ready", needing: 0 });
    expect(titleStateOf([idle, ended])).toEqual({ state: "ready", needing: 0 });
  });

  it("is working while any session has a run in flight, from the key that started it", () => {
    expect(titleStateOf([idle, running])).toEqual({ state: "working", needing: 0 });
    expect(titleStateOf([starting])).toEqual({ state: "working", needing: 0 });
  });

  it("lets a waiting prompt outrank work in flight, wherever either is, and counts the sessions waiting", () => {
    expect(titleStateOf([running, asking])).toEqual({ state: "needs-you", needing: 1 });
    expect(titleStateOf([asking, asking, asking, running, idle])).toEqual({ state: "needs-you", needing: 3 });
    expect(titleFor({ ...titleStateOf([asking, asking]), folder: "harness" })).toContain("2 need you");
  });

  it("counts a session parked with its run still going once, as waiting, and never reports a count otherwise", () => {
    expect(titleStateOf([{ status: "running", pendingPrompts: 2 }])).toEqual({ state: "needs-you", needing: 1 });
    expect(titleStateOf([running]).needing).toBe(0);
  });
});

describe("noticeFor", () => {
  it("names the session in the title and what waits in the body", () => {
    expect(noticeFor("needs-you", { session: "Rework the parser", prompt: "permission", tool: "Bash" })).toEqual({
      kind: "needs-you",
      title: "Rework the parser",
      body: "Bash is waiting for permission",
    });
    expect(noticeFor("needs-you", { session: "Rework the parser", prompt: "denylist", tool: "Read" }).body).toBe("Read is waiting for permission");
    expect(noticeFor("needs-you", { prompt: "question" }).body).toBe("A question is waiting for an answer");
    expect(noticeFor("needs-you", { prompt: "plan" }).body).toBe("A plan is waiting for approval");
  });

  it("says something useful with no session and no tool, and treats a blank name as none", () => {
    expect(noticeFor("needs-you")).toEqual({ kind: "needs-you", title: "agent-harness", body: "Waiting for permission" });
    expect(noticeFor("finished", { session: "   " }).title).toBe("agent-harness");
  });

  it("carries the first line with words of the reply for a finished turn, and falls back when there are none", () => {
    expect(noticeFor("finished", { session: "Rework the parser", reply: "\n\nFixed the redirect loop.\n\nIt was the trailing slash." }).body).toBe("Fixed the redirect loop.");
    expect(noticeFor("finished", { reply: "   \n\t\nDone." }).body).toBe("Done.");
    expect(noticeFor("finished", { reply: "\n \n" }).body).toBe("The turn has finished");
    expect(noticeFor("finished").body).toBe("The turn has finished");
  });
});

describe("awayRecap", () => {
  const away = 1_000;
  const back = 2_000;
  const finished = (title: string, run: Partial<RunEnded> = {}): RecapSubject => ({ title, status: "ended", pendingPrompts: 0, lastRun: { at: back, ...run } });
  const waiting = (title: string, askedAt = back): RecapSubject => ({ title, status: "parked", pendingPrompts: 1, askedAt });

  it("names what finished and what it cost, and what waits", () => {
    expect(awayRecap([finished("refactor", { durationMs: 130_000, costUsd: 0.08 }), waiting("release notes")], away)).toBe(
      "while you were away: refactor finished (2m 10s, $0.080) · release notes is waiting on you",
    );
  });

  it("drops the parenthesis rather than apologising inside it", () => {
    expect(awayRecap([finished("refactor")], away)).toBe("while you were away: refactor finished");
    expect(awayRecap([finished("refactor", { durationMs: 4_000 })], away)).toBe("while you were away: refactor finished (4.0s)");
  });

  it("names two and counts the rest, in the order given", () => {
    expect(awayRecap([finished("one"), finished("two"), finished("three"), finished("four")], away)).toBe("while you were away: one finished · two finished · +2 more");
    expect(awayRecap([waiting("b"), finished("a")], away)).toBe("while you were away: b is waiting on you · a finished");
  });

  it("says nothing at all when nothing changed while the person was away", () => {
    expect(awayRecap([], away)).toBeUndefined();
    expect(awayRecap([finished("refactor", { at: 500 })], away)).toBeUndefined();
    expect(awayRecap([waiting("release notes", 500)], away)).toBeUndefined();
    expect(awayRecap([{ status: "idle", pendingPrompts: 0 }], away)).toBeUndefined();
  });

  it("keeps quiet about a session whose next run is going, and does not call a crash an answer", () => {
    expect(awayRecap([{ ...finished("refactor"), status: "running" }], away)).toBeUndefined();
    expect(awayRecap([finished("refactor", { failed: true, durationMs: 130_000 })], away)).toBe("while you were away: refactor stopped with an error");
    expect(awayRecap([{ ...finished("x"), title: "  " }], away)).toBe("while you were away: a session finished");
  });
});
