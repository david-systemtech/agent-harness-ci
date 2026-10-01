import { describe, expect, it } from "vitest";
import type { RunsView, SessionRun } from "../projections/runs.js";
import { harnessActivity, notificationFor, titleStateOf, type SessionActivity } from "./policy.js";

/**
 * What a client says to somebody who is not looking at it: every one of
 * these decisions is about a person away from the screen, which is why they
 * are worth pinning.
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
  });

  it("counts a session parked with its run still going once, as waiting, and never reports a count otherwise", () => {
    expect(titleStateOf([{ status: "running", pendingPrompts: 2 }])).toEqual({ state: "needs-you", needing: 1 });
    expect(titleStateOf([running]).needing).toBe(0);
  });
});

describe("harnessActivity", () => {
  const run = (environmentId: string, sessionId: string, state: SessionRun["state"]): [string, SessionRun] => [sessionId, { environmentId, sessionId, state, runId: null, since: null }];
  const runs = (...sessions: [string, SessionRun][]): RunsView => {
    const byEnvironment = new Map<string, Map<string, SessionRun>>();
    for (const [sessionId, session] of sessions) byEnvironment.set(session.environmentId, (byEnvironment.get(session.environmentId) ?? new Map()).set(sessionId, session));
    return { sessions: byEnvironment, parkedAsks: [] };
  };

  it("reduces every session of every environment, a parked one waiting on a person", () => {
    expect(harnessActivity(runs())).toEqual({ state: "ready", needing: 0 });
    expect(harnessActivity(runs(run("desk", "s-1", "idle"), run("laptop", "s-2", "running")))).toEqual({ state: "working", needing: 0 });
    expect(harnessActivity(runs(run("desk", "s-1", "parked"), run("laptop", "s-2", "parked"), run("laptop", "s-3", "running")))).toEqual({ state: "needs-you", needing: 2 });
  });
});

describe("notificationFor", () => {
  it("names the session in the title and what waits in the body", () => {
    expect(notificationFor("needs-you", { session: "Rework the parser", prompt: "permission", tool: "Bash" })).toEqual({
      kind: "needs-you",
      title: "Rework the parser",
      body: "Bash is waiting for permission",
    });
    expect(notificationFor("needs-you", { session: "Rework the parser", prompt: "denylist", tool: "Read" }).body).toBe("Read is waiting for permission");
    expect(notificationFor("needs-you", { prompt: "question" }).body).toBe("A question is waiting for an answer");
    expect(notificationFor("needs-you", { prompt: "plan" }).body).toBe("A plan is waiting for approval");
  });

  it("says something useful with no session and no tool, and treats a blank name as none", () => {
    expect(notificationFor("needs-you")).toEqual({ kind: "needs-you", title: "agent-harness", body: "Waiting for permission" });
    expect(notificationFor("finished", { session: "   " }).title).toBe("agent-harness");
  });

  it("carries the first line with words of the reply for a finished turn, and falls back when there are none", () => {
    expect(notificationFor("finished", { session: "Rework the parser", reply: "\n\nFixed the redirect loop.\n\nIt was the trailing slash." }).body).toBe("Fixed the redirect loop.");
    expect(notificationFor("finished", { reply: "   \n\t\nDone." }).body).toBe("Done.");
    expect(notificationFor("finished", { reply: "\n \n" }).body).toBe("The turn has finished");
    expect(notificationFor("finished").body).toBe("The turn has finished");
  });
});
