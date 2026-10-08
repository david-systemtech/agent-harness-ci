import { BANK_RULE_IDS, type BankStatus } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { BankRecord } from "./records.js";
import { memoryBankStateChecks } from "./step-checks.js";

/**
 * The Memory bank step's lines (setup-copy.md §5.8; #1698, #1854): one plain
 * line per bank and problem, its fix named, the raw facts in details. An
 * unreachable bank names one cause: its folder missing here, no forge account
 * here, the account on the computer it was copied from, its repository
 * missing on its forge, or else a plain could-not-reach line.
 */

const SINCE = "2026-10-06T08:00:00.000Z";
const PULL_REQUEST = "https://forge.example.test/acme/bank/pulls/7";

const bank = (status: Partial<BankStatus>, record: Partial<Omit<BankRecord, "status">> = {}): BankRecord => ({
  id: "bank-1",
  name: "acme",
  kind: "team",
  enabled: true,
  checkout: "/srv/banks/acme",
  host: "forge.example.test",
  copiedFrom: null,
  entities: [],
  scopes: [],
  status: {
    reachable: { state: "reachable", since: SINCE },
    manifest: { state: "valid", since: SINCE },
    orientation: { missing: [], since: SINCE },
    owners: { unresolved: [], since: SINCE },
    landing: { state: "ok", since: SINCE },
    lastSync: null,
    ...status,
  },
  ...record,
});

type CheckId = keyof ReturnType<typeof memoryBankStateChecks>;

const answer = async (id: CheckId, ...records: BankRecord[]) => memoryBankStateChecks({ list: () => records, verify: async () => records })[id]({ maxAgeMs: 0 });

const unreachable = (reason: string, cause?: "folder-missing" | "no-forge-account" | "repository-missing"): Partial<BankStatus> => ({
  reachable: { state: "unreachable", reason, ...(cause !== undefined && { cause }), since: SINCE },
});

describe("memory-bank.present", () => {
  it("answers skipped with §5.8's skip line when no bank is registered", async () => {
    expect(await answer("memory-bank.present")).toEqual({ reason: "No notebook yet. Optional." });
  });
});

describe("memory-bank.reachable names one cause per bank, the raw reason in details", () => {
  it("names the missing forge account on this computer, never the forge's refusal", async () => {
    const reason = "No forge account on this environment covers https://forge.example.test, and it refused an anonymous read (HTTP 404): add one in Set up, Forges.";
    expect(await answer("memory-bank.reachable", bank(unreachable(reason, "no-forge-account")))).toEqual({
      reason: "acme needs a forge account for forge.example.test on this computer.",
      details: [`acme: ${reason}`],
      targets: [{ action: "check-again", kind: "bank", id: "bank-1", label: "acme" }],
    });
  });

  it("names the computer the bank was copied from when no forge account here covers it", async () => {
    const answered = await answer("memory-bank.reachable", bank(unreachable("No forge account covers it.", "no-forge-account"), { copiedFrom: "office-server" }));
    expect(answered).toMatchObject({ reason: "Your forge.example.test account is connected on office-server, not here. Connect it here too." });
  });

  it("names the repository missing on its forge, not a forge account to add", async () => {
    const answered = await answer("memory-bank.reachable", bank(unreachable("https://forge.example.test has no repository acme/bank", "repository-missing")));
    expect(answered).toMatchObject({ reason: "The repository for acme is missing on forge.example.test.", details: ["acme: https://forge.example.test has no repository acme/bank"] });
  });

  it("names the folder missing on this computer, its path only in details", async () => {
    const answered = await answer("memory-bank.reachable", bank(unreachable("its repository at /srv/banks/acme is not there", "folder-missing"), { host: null }));
    expect(answered).toMatchObject({ reason: "acme's folder on this computer is missing.", details: ["acme: its repository at /srv/banks/acme is not there"] });
  });

  it("says it cannot reach the bank for any other cause, a status recorded before causes included", async () => {
    const answered = await answer("memory-bank.reachable", bank(unreachable("https://forge.example.test did not answer: connect ECONNREFUSED")));
    expect(answered).toMatchObject({ reason: "agent-harness cannot reach acme. Choose Check again.", details: ["acme: https://forge.example.test did not answer: connect ECONNREFUSED"] });
  });

  it("puts one line per bank, each bank's raw reason in details", async () => {
    const answered = await answer(
      "memory-bank.reachable",
      bank(unreachable("gone", "folder-missing")),
      bank(unreachable("no account", "no-forge-account"), { id: "bank-2", name: "maya-memory", host: "git.example.test" }),
    );
    expect(answered).toMatchObject({
      reason: "acme's folder on this computer is missing. maya-memory needs a forge account for git.example.test on this computer.",
      details: ["acme: gone", "maya-memory: no account"],
    });
  });
});

describe("memory-bank.manifest", () => {
  it("asks for a description when BANK.md is missing", async () => {
    expect(await answer("memory-bank.manifest", bank({ manifest: { state: "missing", since: SINCE } }))).toMatchObject({ reason: "acme needs a description." });
  });

  it("says the description's problem in plain words, the rule's id and message only in details", async () => {
    const message = "A key the new ones replace: description and index in BANK.md.";
    const answered = await answer("memory-bank.manifest", bank({ manifest: { state: "invalid", rule: "retired_key", message, since: SINCE } }));
    expect(answered).toEqual({
      reason: "acme's description has a problem: it uses keys from an older layout.",
      details: [`acme: retired_key: ${message}`],
      targets: [{ action: "revise", kind: "bank", id: "bank-1", label: "acme" }],
    });
  });

  it("has a plain phrase for every rule a BANK.md can fail, none naming a rule id", async () => {
    for (const rule of BANK_RULE_IDS) {
      const answered = await answer("memory-bank.manifest", bank({ manifest: { state: "invalid", rule, message: "The rule's message.", since: SINCE } }));
      if (answered === true) throw new Error(`${rule} holds.`);
      expect(answered.reason).toMatch(/^acme's description has a problem: [a-z][^_]+\.$/);
    }
  });

  it("holds, saying the description waits for the person's approval on its forge, the pull request in details", async () => {
    expect(await answer("memory-bank.manifest", bank({ manifest: { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } }))).toEqual({
      holds: true,
      reason: "acme's description is waiting for your approval on forge.example.test.",
      details: [PULL_REQUEST],
    });
  });

  it("names the description waiting even when a landing waits in the same pull request", async () => {
    const awaiting = { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } as const;
    expect(await answer("memory-bank.manifest", bank({ manifest: awaiting, landing: awaiting }))).toMatchObject({
      holds: true,
      reason: "acme's description is waiting for your approval on forge.example.test.",
    });
  });

  it("holds with nothing more to say for a BANK.md valid on main", async () => {
    expect(await answer("memory-bank.manifest", bank({}))).toBe(true);
  });
});

describe("memory-bank.orientation", () => {
  it("says the summary names notes that do not exist, the names in details", async () => {
    expect(await answer("memory-bank.orientation", bank({ orientation: { missing: ["who-is-who", "where-work-is"], since: SINCE } }))).toEqual({
      reason: "acme's summary names notes that do not exist.",
      details: ["acme: who-is-who, where-work-is"],
    });
  });
});

describe("memory-bank.owners", () => {
  it("names each owner its forge does not know", async () => {
    expect(await answer("memory-bank.owners", bank({ owners: { unresolved: ["maya-reyes", "sam-ortiz"], since: SINCE } }))).toEqual({
      reason: "forge.example.test does not know maya-reyes, listed as an owner of acme. forge.example.test does not know sam-ortiz, listed as an owner of acme.",
    });
  });
});

describe("memory-bank.landing", () => {
  it("says the last change could not be saved to its forge, the step and reason in details", async () => {
    const answered = await answer("memory-bank.landing", bank({ landing: { state: "failed", step: "push", reason: "The forge refused the push.", since: SINCE } }));
    expect(answered).toEqual({
      reason: "The last change to acme could not be saved to forge.example.test.",
      details: ["acme: push: The forge refused the push."],
      targets: [{ action: "check-again", kind: "bank", id: "bank-1", label: "acme" }],
    });
  });

  it("says the last change could not be saved on a bank kept on this computer only", async () => {
    const answered = await answer("memory-bank.landing", bank({ landing: { state: "failed", step: "commit", reason: "git commit exited 1", since: SINCE } }, { host: null }));
    expect(answered).toMatchObject({ reason: "The last change to acme could not be saved." });
  });

  it("holds, saying the latest changes wait for the person's approval, the pull request in details", async () => {
    expect(await answer("memory-bank.landing", bank({ landing: { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } }))).toEqual({
      holds: true,
      reason: "acme's latest changes are waiting for your approval on forge.example.test.",
      details: [PULL_REQUEST],
    });
  });

  it("leaves a landing waiting in the description's pull request to the manifest check's line", async () => {
    const awaiting = { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } as const;
    expect(await answer("memory-bank.landing", bank({ manifest: awaiting, landing: awaiting }))).toBe(true);
  });
});
