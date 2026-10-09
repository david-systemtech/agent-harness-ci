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
    expect(resetWords(null, new Date(2026, 9, 8, 21, 12))).toBeUndefined();
  });
});

describe("when a window resets (#1955)", () => {
  // Read on a Thursday evening, 2026-10-08 at 21:12 on this client's calendar.
  const now = new Date(2026, 9, 8, 21, 12);
  const resets = (month: number, day: number, hours: number, minutes = 0, year = 2026) => resetWords(new Date(year, month, day, hours, minutes).toISOString(), now);

  it("says the clock time alone today", () => {
    expect(resets(9, 8, 22, 50)).toBe("resets 22:50");
  });

  it("says tomorrow and the time on the next day", () => {
    expect(resets(9, 9, 1)).toBe("resets tomorrow 01:00");
  });

  it("says the weekday and the time within the week", () => {
    expect(resets(9, 11, 22)).toBe("resets Sun 22:00");
    expect(resets(9, 14, 9)).toBe("resets Wed 09:00");
  });

  it("says the date and the time beyond the week, the year too when it is not this one", () => {
    expect(resets(9, 15, 9)).toBe("resets 15 Oct 09:00");
    expect(resets(10, 5, 7, 59)).toBe("resets 5 Nov 07:59");
    expect(resets(0, 2, 9, 0, 2027)).toBe("resets 2 Jan 2027 09:00");
  });

  it("counts days on the calendar, not in 24-hour spans, across a local midnight", () => {
    const beforeMidnight = new Date(2026, 9, 8, 23, 59);
    const afterMidnight = new Date(2026, 9, 9, 0, 1);
    expect(resetWords(new Date(2026, 9, 9, 0, 1).toISOString(), beforeMidnight)).toBe("resets tomorrow 00:01");
    expect(resetWords(new Date(2026, 9, 9, 0, 1).toISOString(), afterMidnight)).toBe("resets 00:01");
    expect(resetWords(new Date(2026, 9, 9, 23, 0).toISOString(), afterMidnight)).toBe("resets 23:00");
    expect(resetWords(new Date(2026, 9, 10, 0, 30).toISOString(), afterMidnight)).toBe("resets tomorrow 00:30");
  });
});
