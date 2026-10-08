import type { AccountCatalogue, AmbientProbe } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { accountStatusWords, ambientSignIn, DEFAULT_CHOICE_WORDS, directoryWords, effortChoices, familyChoices, familyWords, gaugeWho, removalWords, resetWords } from "./words.js";

/** The Accounts rows' words, as both renderers say them (docs/specs/gui.md, "Settings"; #414). */

const model = (id: string, family: string, tier: number, efforts: readonly string[] = [], label: string | null = null) => ({ id, family, tier, efforts: [...efforts], label });

const CATALOGUES: readonly AccountCatalogue[] = [
  { accountId: "account-1", live: true, models: [model("claude-sonnet-4", "sonnet", 1, ["low"]), model("claude-opus-5", "opus", 3, ["low", "high", "xhigh"], "Claude Opus 5")] },
  { accountId: "account-2", live: false, models: [model("claude-sonnet-5", "sonnet", 2, ["low", "medium", "high"]), model("claude-opus-5", "opus", 3, ["low", "high", "xhigh"], "Claude Opus 5")] },
];

describe("the default model's choices", () => {
  it("are every family the accounts offer, strongest first, each with its strongest model on any account", () => {
    const families = familyChoices(CATALOGUES);
    expect(families.map(familyWords)).toEqual(["opus: Claude Opus 5 (claude-opus-5)", "sonnet: claude-sonnet-5"]);
    expect(familyChoices([])).toEqual([]);
  });

  it("offer the efforts of the model the family gives a run, the strongest of all while no family offered is set", () => {
    expect(effortChoices(CATALOGUES, "sonnet")).toEqual(["low", "medium", "high"]);
    expect(effortChoices(CATALOGUES, null)).toEqual(["low", "high", "xhigh"]);
    expect(effortChoices(CATALOGUES, "gpt")).toEqual(["low", "high", "xhigh"]);
    expect(effortChoices([], null)).toEqual([]);
  });
});

const PROBE: AmbientProbe = {
  provider: "claude",
  directory: "/home/milo/.claude",
  present: true,
  signedIn: true,
  identity: { provider: "claude", email: "milo@example.test", organisation: null },
  accountId: null,
  detail: null,
  checkedAt: "2026-09-30T10:00:00.000Z",
};

describe("the machine's own sign-in (setup-copy.md §5.1)", () => {
  it("is offered while it is there, signed in and held by no account, named by its email and never by its folder", () => {
    expect(ambientSignIn(PROBE, "this computer")).toEqual({ kind: "offer", choice: "Use the Claude Code sign-in on this computer (milo@example.test)" });
    expect(ambientSignIn(PROBE, "desk")).toEqual({ kind: "offer", choice: "Use the Claude Code sign-in on desk (milo@example.test)" });
    expect(ambientSignIn({ ...PROBE, identity: null }, "this computer")).toEqual({ kind: "offer", choice: "Use the Claude Code sign-in on this computer" });
  });

  it("says Claude Code is there but signed out, so Sign in with Claude is the way, while no account holds it", () => {
    expect(ambientSignIn({ ...PROBE, signedIn: false, identity: null }, "this computer")).toEqual({ kind: "signed-out", line: "Claude Code is on this computer but not signed in. Sign in below instead." });
    expect(ambientSignIn({ ...PROBE, signedIn: false }, "desk")).toEqual({ kind: "signed-out", line: "Claude Code is on desk but not signed in. Sign in below instead." });
  });

  it("says nothing while it is not there, is held by an account, or was not read", () => {
    for (const absent of [{ present: false }, { accountId: "account-1" }, { directory: null }, { signedIn: false, accountId: "account-1" }]) expect(ambientSignIn({ ...PROBE, ...absent }, "this computer")).toBeUndefined();
    expect(ambientSignIn(null, "this computer")).toBeUndefined();
    expect(ambientSignIn(undefined, "this computer")).toBeUndefined();
  });
});

describe("an account's row (setup-copy.md §5.1)", () => {
  it("says its state as a word, the read's error left to Details", () => {
    expect(accountStatusWords({ state: "signed-in" })).toBe("Signed in");
    expect(accountStatusWords({ state: "signed-out" })).toBe("Signed out");
    expect(accountStatusWords({ state: "expired" })).toBe("Sign-in ran out");
    const unreadable = { state: "unreadable", detail: "auth status exited 1" } as const;
    expect(accountStatusWords(unreadable)).toBe("Cannot read the sign-in");
  });

  it("keeps its folder for Details, saying whose it is", () => {
    expect(directoryWords({ directory: { kind: "adopted", path: "/home/milo/.claude" } })).toBe("Folder: /home/milo/.claude (Claude Code's own, used in place)");
    expect(directoryWords({ directory: { kind: "owned", path: "/data/accounts/a1" } })).toBe("Folder: /data/accounts/a1 (made by agent-harness)");
  });

  it("says what removing it leaves, with no folder path", () => {
    expect(removalWords({ directory: { kind: "adopted", path: "/home/milo/.claude" } }, "this computer")).toBe("Claude Code stays signed in on this computer.");
    expect(removalWords({ directory: { kind: "owned", path: "/data/accounts/a1" } }, "desk")).toBe("Its sign-in and history stay on desk unless you delete them too.");
  });

  it("says a default account that was removed by what new sessions use, never by its id", () => {
    expect(DEFAULT_CHOICE_WORDS["accounts.defaultAccount"].missing()).toBe("The account you chose was removed. New sessions use your first account.");
  });
});

describe("an account and its gauge", () => {
  it("say who a gauge pools, and when a window resets", () => {
    expect(gaugeWho({ identity: PROBE.identity })).toBe("milo@example.test");
    expect(gaugeWho({ identity: null })).toBe("An account never read");
    expect(resetWords(null)).toBeUndefined();
    expect(resetWords("2026-09-30T14:05:00.000Z")).toMatch(/^resets \d\d:\d\d$/);
  });
});
