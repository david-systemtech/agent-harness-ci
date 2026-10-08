import type { SignIn } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { codeRefused, notStartedLine, signInEnd, signInLeftWords, startRefusedLine } from "./sign-in.js";

const signIn = (fields: Partial<SignIn>): SignIn => ({
  accountId: "0199aa00-0000-4000-8000-000000000001",
  state: "awaiting-code",
  url: "https://claude.test/oauth/authorize?code=true&state=for-tests",
  startedAt: "2026-10-08T10:00:00.000Z",
  expiresAt: "2026-10-08T10:10:00.000Z",
  fallback: { posix: "claude auth login", powershell: "claude auth login" },
  error: null,
  ...fields,
});

describe("a sign-in's end (setup-copy.md §5.2)", () => {
  it("is nothing while it runs", () => {
    for (const state of ["starting", "awaiting-code", "submitting"] as const) expect(signInEnd(signIn({ state }), "Personal")).toBeUndefined();
  });

  it("says a done sign-in names the account, with nothing more to do", () => {
    expect(signInEnd(signIn({ state: "done" }), "Personal")).toEqual({ kind: "done", title: "Personal is signed in.", next: null, line: "Personal is signed in.", again: false, details: [] });
  });

  it("says a code the provider refused plainly, with Start again and the CLI's words for Details, never a doubled full stop", () => {
    const error = "The provider's CLI exited with code 1: Login failed: Request failed with status code 400.";
    const end = signInEnd(signIn({ state: "failed", error, cause: "code-refused" }), "Personal");
    expect(end).toEqual({
      kind: "stopped",
      title: "Claude did not accept this code.",
      next: "Start the sign-in again.",
      line: "Claude did not accept this code. Start the sign-in again.",
      again: true,
      details: [error],
    });
    expect(end?.line).not.toContain("..");
    expect(end?.line).not.toContain("400");
  });

  it("says any other failure did not finish, and an expiry ran out of time, each with Start again", () => {
    expect(signInEnd(signIn({ state: "failed", error: "The provider's CLI could not be started: spawn EACCES" }), "Personal")).toMatchObject({
      kind: "stopped", line: "The sign-in did not finish. Choose Start again.", again: true, details: ["The provider's CLI could not be started: spawn EACCES"],
    });
    expect(signInEnd(signIn({ state: "failed", error: null }), "Personal")).toMatchObject({ line: "The sign-in did not finish. Choose Start again.", details: [] });
    expect(signInEnd(signIn({ state: "expired", error: "No code came within ten minutes; start the sign-in again." }), "Personal")).toMatchObject({
      kind: "stopped", title: "The sign-in ran out of time.", next: "Choose Start again.", again: true,
    });
  });

  it("says why the system cancelled it: a restart can start again, a removed account cannot", () => {
    expect(signInEnd(signIn({ state: "cancelled", error: "The environment restarted.", cause: "restarted" }), "Personal")).toEqual({
      kind: "stopped",
      title: "The sign-in stopped because agent-harness restarted.",
      next: "Choose Start again.",
      line: "The sign-in stopped because agent-harness restarted. Choose Start again.",
      again: true,
      details: ["The environment restarted."],
    });
    expect(signInEnd(signIn({ state: "cancelled", error: "The account was removed.", cause: "account-removed" }), "Personal")).toMatchObject({
      kind: "stopped", line: "The sign-in stopped because Personal was removed.", next: null, again: false,
    });
  });

  it("says a person's cancel in one line", () => {
    expect(signInEnd(signIn({ state: "cancelled" }), "Personal")).toMatchObject({ kind: "cancelled", line: "The sign-in was cancelled.", again: false });
  });
});

describe("the time a sign-in has left", () => {
  it("counts whole minutes up, then says less than a minute", () => {
    expect(signInLeftWords(600_000)).toBe("10 min left");
    expect(signInLeftWords(61_000)).toBe("2 min left");
    expect(signInLeftWords(60_000)).toBe("Less than a minute left.");
    expect(signInLeftWords(0)).toBe("Less than a minute left.");
  });
});

describe("a refusal along the way", () => {
  it("of the code says Claude did not accept it, the refusal in Details", () => {
    expect(codeRefused({ code: "conflict", message: "The sign-in of Personal is starting, not awaiting a code.", data: { reason: "not_awaiting_code" } })).toEqual({
      kind: "stopped",
      title: "Claude did not accept this code.",
      next: "Start the sign-in again.",
      line: "Claude did not accept this code. Start the sign-in again.",
      again: true,
      details: ["conflict (not_awaiting_code): The sign-in of Personal is starting, not awaiting a code."],
    });
  });

  it("of the start names the account whose sign-in runs, else words the refusal plainly", () => {
    expect(startRefusedLine({ code: "conflict", message: "A sign-in is already running for Work; cancel it, or wait for it to end.", data: { reason: "signin_running", accountId: "a", label: "Work" } }))
      .toBe("Another sign-in is running for Work. Finish or cancel it first.");
    expect(startRefusedLine({ code: "conflict", message: "A sign-in is already running.", data: { reason: "signin_running", accountId: "a" } }))
      .toBe("Another sign-in is running. Finish or cancel it first.");
    expect(startRefusedLine({ code: "unreachable", message: "No connection." })).toBe("This app cannot reach that computer right now. Choose Sign in again to try again.");
  });

  it("of an add's sign-in says the account is added and why its sign-in did not start", () => {
    expect(notStartedLine("Personal", { started: false, reason: "signin_running", message: "A sign-in is already running for Work; cancel it, or wait for it to end. Sign Personal in once it has ended." }))
      .toBe("Personal is added. Its sign-in did not start because another sign-in is running. Finish that one first.");
    expect(notStartedLine("Personal", { started: false, reason: "signin_unavailable", message: "Signing in from the environment is not available for the fake provider." }))
      .toBe("Personal is added. agent-harness cannot sign it in on that computer. Sign in with Claude Code there instead.");
  });
});
