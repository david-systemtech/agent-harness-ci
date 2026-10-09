import type { AccountCatalogue, AmbientProbe } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { accountStatusWords, ambientOffer, effortChoices, familyChoices, familyWords, gaugeWho, resetWords } from "./words.js";

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

describe("the machine's own sign-in", () => {
  it("is offered while it is there, signed in and held by no account, named by its email, else its directory", () => {
    expect(ambientOffer(PROBE, "desk")).toBe("Use the Claude Code sign-in on desk's machine (milo@example.test)");
    expect(ambientOffer({ ...PROBE, identity: null }, "desk")).toBe("Use the Claude Code sign-in on desk's machine (/home/milo/.claude)");
    for (const refused of [{ present: false }, { signedIn: false }, { accountId: "account-1" }, { directory: null }]) expect(ambientOffer({ ...PROBE, ...refused }, "desk")).toBeUndefined();
    expect(ambientOffer(null, "desk")).toBeUndefined();
  });
});

describe("an account and its gauge", () => {
  it("say the status with why when the read said, who a gauge pools, and when a window resets", () => {
    expect(accountStatusWords({ state: "signed-out", detail: null })).toBe("signed out");
    expect(accountStatusWords({ state: "unreadable", detail: "auth status exited 1" })).toBe("status unreadable: auth status exited 1");
    expect(gaugeWho({ identity: PROBE.identity })).toBe("milo@example.test");
    expect(gaugeWho({ identity: null })).toBe("An account never read");
    const now = new Date(2026, 8, 30, 10, 0);
    expect(resetWords(null, now)).toBeUndefined();
    expect(resetWords(new Date(2026, 8, 30, 14, 5).toISOString(), now)).toBe("resets 14:05");
  });

  it("name the day of a reset that is not today, as a weekly window's is (#1951)", () => {
    expect(resetWords(new Date(2026, 9, 6, 9, 30).toISOString(), new Date(2026, 8, 30, 10, 0))).toBe("resets 6 Oct 09:30");
  });
});
