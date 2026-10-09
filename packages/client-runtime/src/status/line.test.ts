import type { HandoffRecommendation, RunSummary, SessionSummary, SignIn } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { freshSummary } from "../../../contracts/test/session-fixtures.js";
import { modeBadgeOf, statusOf, type StatusInput } from "./line.js";
import { fallbackOf, followedSignIn } from "./sign-in.js";

/**
 * What the status line says, as both renderers say it (docs/specs/tui.md,
 * "Status, usage, pickers"; docs/specs/gui.md, "A session pane"; #402): pure
 * over what a renderer reads and hands in.
 */

const run = (fields: Partial<RunSummary> = {}): RunSummary => ({
  runId: "0199a100-0000-4000-8000-000000000001",
  state: "ended",
  origin: "client",
  accountId: "account-1",
  model: "claude-opus-4",
  effort: "high",
  mode: { requested: null, effective: "acceptEdits", clamped: false },
  promptMessageId: null,
  queuedMessageIds: [],
  startedAt: "2026-09-25T09:00:00.000Z",
  endedAt: "2026-09-25T09:01:00.000Z",
  reason: "completed",
  cause: null,
  error: null,
  usage: [{ model: "claude-opus-4", inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.05, contextWindow: null }],
  durationMs: 60_000,
  ...fields,
});

const summary = (fields: Partial<SessionSummary> = {}): SessionSummary => ({ ...(freshSummary as SessionSummary), ...fields });

const input = (fields: Partial<StatusInput> = {}): StatusInput => ({
  projection: { summary: summary(), runs: [], items: [], containment: null },
  runState: "idle",
  liveRunId: undefined,
  ceiling: "bypassPermissions",
  forkedOnto: undefined,
  containmentDefault: "workspace",
  recommendation: null,
  now: () => Date.parse("2026-09-25T09:02:04.000Z"),
  ...fields,
});

const outOfRoom: HandoffRecommendation = {
  accountId: "account-2",
  reason: "limit-reached",
  message: "The 5-hour window of work is out until 14:30; personal has the most room (88%).",
  fromAccountId: "account-1",
  trigger: null,
  headroom: 0.88,
  binding: "five_hour",
  candidates: 1,
  basis: "same-plan",
};

describe("the mode badge", () => {
  it("is the session's mode, or the attended default lowered to the ceiling, which is no clamp", () => {
    expect(modeBadgeOf("auto", "bypassPermissions", undefined)).toEqual({ mode: "auto", clampedFrom: null });
    expect(modeBadgeOf(null, "plan", undefined)).toEqual({ mode: "plan", clampedFrom: null });
    expect(modeBadgeOf(null, null, undefined)).toEqual({ mode: "acceptEdits", clampedFrom: null });
  });

  it("shows the clamp of a session's mode above this connection's ceiling", () => {
    expect(modeBadgeOf("bypassPermissions", "auto", undefined)).toEqual({ mode: "auto", clampedFrom: "bypassPermissions" });
  });

  it("shows the clamp the latest run got for the session's mode, past a mode its account cannot use", () => {
    const clamped = run({ mode: { requested: "auto", effective: "acceptEdits", clamped: true } });
    expect(modeBadgeOf("auto", "bypassPermissions", clamped)).toEqual({ mode: "acceptEdits", clampedFrom: "auto" });
    // A run that asked for another mode than the session's now says nothing of it.
    expect(modeBadgeOf("plan", "bypassPermissions", clamped)).toEqual({ mode: "plan", clampedFrom: null });
  });
});

describe("the status line", () => {
  it("says the latest run's account, model and effort, the session's own containment, and the last run's spend while idle", () => {
    const facts = statusOf(input({ projection: { summary: summary({ accountId: "account-1", mode: "auto" }), runs: [run()], items: [], containment: "workspace-no-network" } }));
    expect(facts).toMatchObject({
      accountId: "account-1",
      model: { model: "claude-opus-4", effort: "high" },
      mode: { mode: "auto", clampedFrom: null },
      containment: { level: "workspace-no-network", isDefault: false },
      live: false,
      activity: { kind: "idle", words: "idle" },
      elapsedMs: undefined,
      spend: { tokens: 1500, costUsd: 0.05 },
      offer: undefined,
    });
  });

  it("says what the session's next run goes out on before any run says it, the account this client handed off onto, and the default containment marked so", () => {
    const facts = statusOf(input({ projection: { summary: summary({ runChoice: { model: "claude-sonnet-4", effort: null } }), runs: [], items: [], containment: null }, forkedOnto: "account-2" }));
    expect(facts).toMatchObject({ accountId: "account-2", model: { model: "claude-sonnet-4", effort: null }, containment: { level: "workspace", isDefault: true } });
  });

  it("names the model and effort the session's next run goes out on, not the latest run's, whatever this client last chose (#1961)", () => {
    const chosen = summary({ accountId: "account-1", model: "claude-opus-4", runChoice: { model: "claude-sonnet-4", effort: null } });
    expect(statusOf(input({ projection: { summary: chosen, runs: [run()], items: [], containment: null } })).model).toEqual({ model: "claude-sonnet-4", effort: null });
  });

  it("says what the live run does and for how long, in the environment's time", () => {
    const live = run({ state: "running", endedAt: null, reason: null, usage: null, durationMs: null });
    const facts = statusOf(input({ projection: { summary: summary(), runs: [live], items: [], containment: null }, runState: "running", liveRunId: live.runId }));
    expect(facts).toMatchObject({ live: true, activity: { kind: "working", words: "working" }, elapsedMs: 124_000, spend: undefined });
    expect(statusOf(input({ runState: "parked", liveRunId: live.runId, projection: { summary: summary(), runs: [live], items: [], containment: null } })).activity).toEqual({
      kind: "waiting",
      words: "waiting for you",
    });
  });

  it("offers the hand-off in the recommendation's words while the account's window is out and no run is live", () => {
    expect(statusOf(input({ recommendation: outOfRoom })).offer).toBe(outOfRoom.message);
    expect(statusOf(input({ recommendation: outOfRoom, runState: "starting" })).offer).toBeUndefined();
    expect(statusOf(input({ recommendation: { ...outOfRoom, reason: "most-room" } })).offer).toBeUndefined();
  });
});

describe("the sign-in the card follows", () => {
  const signIn = (fields: Partial<SignIn> = {}): SignIn => ({
    accountId: "account-3",
    state: "awaiting-code",
    url: "https://claude.ai/oauth/authorize?code=true",
    startedAt: "2026-09-25T09:00:00.000Z",
    expiresAt: "2026-09-25T09:10:00.000Z",
    fallback: { posix: "CLAUDE_CONFIG_DIR='/home/milo/a' claude auth login", powershell: "$env:CLAUDE_CONFIG_DIR = 'C:\\a'; & 'claude' auth login" },
    error: null,
    ...fields,
  });

  it("is its account's from when the card started it, and none while the start is on its way", () => {
    const card = { accountId: "account-3", startedAt: "2026-09-25T09:00:00.000Z", starting: false };
    expect(followedSignIn(signIn(), card)).toEqual(signIn());
    expect(followedSignIn(signIn(), { ...card, starting: true })).toBeUndefined();
    expect(followedSignIn(signIn({ accountId: "account-1" }), card)).toBeUndefined();
    expect(followedSignIn(signIn({ startedAt: "2026-09-25T08:00:00.000Z" }), card)).toBeUndefined();
    expect(followedSignIn(null, card)).toBeUndefined();
  });

  it("offers PowerShell's fallback where the account's directory is a Windows path, the POSIX shell's otherwise", () => {
    expect(fallbackOf(signIn(), "C:\\Users\\milo\\a")).toBe(signIn().fallback.powershell);
    expect(fallbackOf(signIn(), "/home/milo/a")).toBe(signIn().fallback.posix);
    expect(fallbackOf(signIn(), undefined)).toBe(signIn().fallback.posix);
  });
});
