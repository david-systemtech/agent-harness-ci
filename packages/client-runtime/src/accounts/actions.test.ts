import type { AccountRecord } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { Runtime } from "../runtime.js";
import { adoptAccount, emailLabel, nameProblem, newAccountLabel, presetModelDefaults, relabelAccount, removeAccount } from "./actions.js";

/** What the Account step and the Accounts pane send and say (setup-copy.md §5.1; #1842). */

/** A runtime whose requests answer `answers` in turn, keeping what each was sent. */
const answering = (...answers: readonly unknown[]) => {
  const sent: { readonly method: string; readonly params: unknown }[] = [];
  const runtime = {
    requests: {
      call: (_environmentId: string, method: string, params: unknown) => {
        sent.push({ method, params });
        return Promise.resolve(answers[sent.length - 1]);
      },
    } as unknown as Runtime["requests"],
  };
  return { runtime, sent };
};
const accepted = (result: unknown = {}) => ({ ok: true, result: { receipt: { status: "accepted", sequence: 3, changed: true }, result } });
const rejected = (code: string, message: string, data: Record<string, unknown>) => ({
  ok: true,
  result: { receipt: { status: "rejected", sequence: 4, changed: false, reason: code, error: { code, message, data } } },
});

const account = (fields: Partial<AccountRecord> = {}): AccountRecord => ({
  id: "account-1",
  provider: "claude",
  label: "Claude account",
  directory: { kind: "owned", path: "/data/accounts/account-1" },
  identity: { provider: "claude", email: "milo@example.test", organisation: null },
  status: { state: "signed-in", checkedAt: "2026-10-08T12:00:00.000Z", detail: null },
  ...fields,
}) as AccountRecord;

describe("a new account's name", () => {
  it("is Claude account, numbered past the names taken, ignoring case", () => {
    expect(newAccountLabel([])).toBe("Claude account");
    expect(newAccountLabel([{ label: "Work" }])).toBe("Claude account");
    expect(newAccountLabel([{ label: "claude ACCOUNT" }])).toBe("Claude account 2");
    expect(newAccountLabel([{ label: "Claude account" }, { label: "Claude account 2" }, { label: "Claude account 4" }])).toBe("Claude account 3");
  });

  it("becomes its email once it is signed in, unless the person renamed it", () => {
    expect(emailLabel(account())).toBe("milo@example.test");
    expect(emailLabel(account({ label: "Claude account 3" }))).toBe("milo@example.test");
    expect(emailLabel(account({ label: "Work" }))).toBeUndefined();
    expect(emailLabel(account({ label: "Claude account two" }))).toBeUndefined();
    expect(emailLabel(account({ status: { state: "signed-out", checkedAt: null, detail: null } }))).toBeUndefined();
    expect(emailLabel(account({ identity: null }))).toBeUndefined();
    // Claude Code's own sign-in takes its email when it is added; one named Claude account was named so on purpose.
    expect(emailLabel(account({ directory: { kind: "adopted", path: "/home/milo/.claude" } }))).toBeUndefined();
  });

  it("says what to do about a name that cannot be used, not the rule", () => {
    expect(nameProblem("")).toBe("Enter a name.");
    expect(nameProblem("   ")).toBe("Enter a name.");
    expect(nameProblem("x".repeat(201))).toBe("Use 200 characters or fewer.");
    expect(nameProblem("two\nlines")).toBe("Use one line.");
    expect(nameProblem(" Work ")).toBeUndefined();
  });
});

describe("using this computer's Claude Code sign-in", () => {
  it("sends no label unless a name was typed, and says the account is signed in", async () => {
    const { runtime, sent } = answering(accepted({ account: account({ label: "milo@example.test" }) }));
    expect(await adoptAccount(runtime, "env-a", "", "c-1")).toEqual({ ok: true, line: "milo@example.test is signed in." });
    expect(sent).toEqual([{ method: "accounts.adopt", params: { commandId: "c-1" } }]);
    const named = answering(accepted({ account: account({ label: "Home" }) }));
    expect(await adoptAccount(named.runtime, "env-a", " Home ", "c-2")).toEqual({ ok: true, line: "Home is signed in." });
    expect(named.sent).toEqual([{ method: "accounts.adopt", params: { commandId: "c-2", label: "Home" } }]);
  });

  it("says the environment's refusal in its own words, its code and reason in Details", async () => {
    const { runtime } = answering(rejected("conflict", "This sign-in is already used by Personal.", { reason: "already_added", accountId: "account-1" }));
    expect(await adoptAccount(runtime, "env-a", "", "c-1")).toEqual({
      ok: false,
      line: "This sign-in is already used by Personal.",
      details: ["conflict (already_added): This sign-in is already used by Personal."],
    });
    const signedOut = answering(rejected("conflict", "Claude Code on this computer is not signed in. Sign in with Claude instead.", { reason: "ambient_unavailable", directory: "/home/milo/.claude" }));
    expect(await adoptAccount(signedOut.runtime, "env-a", "", "c-1")).toEqual({
      ok: false,
      line: "Claude Code on this computer is not signed in. Sign in with Claude instead.",
      details: ["conflict (ambient_unavailable): Claude Code on this computer is not signed in. Sign in with Claude instead.", "Folder: /home/milo/.claude"],
    });
  });

  it("says a sign-in with no email to name it by in the environment's words, its folder in Details", async () => {
    const message = "This sign-in has no email to name the account by. Enter a name.";
    const { runtime } = answering(rejected("conflict", message, { reason: "no_email", directory: "/home/milo/.claude" }));
    expect(await adoptAccount(runtime, "env-a", "", "c-1")).toEqual({ ok: false, line: message, details: [`conflict (no_email): ${message}`, "Folder: /home/milo/.claude"] });
  });

  it("says any other refusal through the refusal mapper, for Use this sign-in", async () => {
    const { runtime } = answering({ ok: false, error: { code: "unreachable", message: "The connection closed." } });
    expect(await adoptAccount(runtime, "env-a", "", "c-1")).toMatchObject({ ok: false, line: "This app cannot reach that computer right now. Choose Use this sign-in to try again." });
  });

  it("sends nothing for a name that cannot be used", async () => {
    const { runtime, sent } = answering();
    expect(await adoptAccount(runtime, "env-a", "x".repeat(201), "c-1")).toEqual({ ok: false, line: "Use 200 characters or fewer." });
    expect(sent).toEqual([]);
  });
});

describe("renaming and removing an account", () => {
  it("renames, saying the new name, and sends nothing for an empty one", async () => {
    const { runtime, sent } = answering(accepted({ account: account({ label: "Work" }) }));
    expect(await relabelAccount(runtime, "env-a", account(), " Work ", "c-1")).toEqual({ ok: true, line: "Renamed Claude account to Work." });
    expect(sent).toEqual([{ method: "accounts.relabel", params: { commandId: "c-1", accountId: "account-1", label: "Work" } }]);
    const empty = answering();
    expect(await relabelAccount(empty.runtime, "env-a", account(), " ", "c-2")).toEqual({ ok: false, line: "Enter a name." });
    expect(empty.sent).toEqual([]);
  });

  it("says a name another account has in the environment's words", async () => {
    const { runtime } = answering(rejected("conflict", "Another account is already called Work. Choose another name.", { reason: "label_taken", accountId: "account-2" }));
    expect(await relabelAccount(runtime, "env-a", account(), "Work", "c-1")).toMatchObject({ ok: false, line: "Another account is already called Work. Choose another name." });
  });

  it("says what removing did with no folder path", async () => {
    const kept = answering(accepted({ accountId: "account-1", directoryDeleted: false }));
    expect(await removeAccount(kept.runtime, "env-a", account(), false, "c-1")).toEqual({ ok: true, line: "Removed Claude account." });
    const deleted = answering(accepted({ accountId: "account-1", directoryDeleted: true }));
    expect(await removeAccount(deleted.runtime, "env-a", account(), true, "c-2")).toEqual({ ok: true, line: "Removed Claude account and deleted its sign-in and history." });
    const refused = answering({ ok: false, error: { code: "timeout", message: "No answer within 30 seconds." } });
    expect(await removeAccount(refused.runtime, "env-a", account(), false, "c-3")).toMatchObject({ ok: false, line: "There was no answer in time. Choose Remove to try again." });
  });
});

describe("the preset after the first sign-in", () => {
  const preset = { family: "opus", model: "Claude Opus 5", effort: "high" } as const;

  it("names the model new sessions will use and where to change it", async () => {
    const { runtime, sent } = answering({ ok: true, result: { values: {} } }, accepted());
    expect(await presetModelDefaults(runtime, "env-a", preset, "c-1")).toEqual({ ok: true, line: "New sessions will use Claude Opus 5 with high effort. You can change this in Settings." });
    expect(sent.at(-1)).toEqual({ method: "settings.update", params: { commandId: "c-1", values: { "accounts.defaultModelFamily": "opus", "accounts.defaultEffort": "high" } } });
  });

  it("writes nothing over a value set", async () => {
    const { runtime, sent } = answering({ ok: true, result: { values: { "accounts.defaultModelFamily": "sonnet" } } });
    expect(await presetModelDefaults(runtime, "env-a", preset, "c-1")).toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("asks to choose a model in More options when it could not write, why in Details", async () => {
    const { runtime } = answering({ ok: true, result: { values: {} } }, rejected("forbidden", "The admin scope is needed.", { reason: "scope" }));
    expect(await presetModelDefaults(runtime, "env-a", preset, "c-1")).toEqual({
      ok: false,
      line: "Choose a model for new sessions in More options.",
      details: ["forbidden (scope): The admin scope is needed."],
    });
  });
});
