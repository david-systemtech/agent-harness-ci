import type { BankStatus } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { BankRecord } from "./records.js";
import { memoryBankStateChecks } from "./step-checks.js";

/**
 * The Memory bank step's manifest check on a BANK.md held by an open pull
 * request (#1698): it holds, as a landed description does (ADR 0019), but
 * says which pull request waits for the person's review, once, beside the
 * landing check's own line for the same pull request.
 */

const SINCE = "2026-10-06T08:00:00.000Z";
const PULL_REQUEST = "https://forge.example.test/acme/bank/pulls/7";

const bank = (status: Partial<BankStatus>): BankRecord => ({
  id: "bank-1",
  name: "acme",
  kind: "team",
  enabled: true,
  checkout: "/srv/banks/acme",
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
});

const manifestOf = async (record: BankRecord) => {
  const records = { list: () => [record], verify: async () => [record] };
  return memoryBankStateChecks(records)["memory-bank.manifest"]({ maxAgeMs: 0 });
};

describe("memory-bank.manifest on a BANK.md awaiting review", () => {
  it("holds, naming the pull request that waits for the person's review", async () => {
    expect(await manifestOf(bank({ manifest: { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } }))).toEqual({
      holds: true,
      reason: `The BANK.md of acme waits for your review: ${PULL_REQUEST}.`,
    });
  });

  it("leaves the pull request to the landing check's line when a landing awaits review in the same one", async () => {
    const awaiting = { state: "awaiting-review", pullRequest: PULL_REQUEST, since: SINCE } as const;
    expect(await manifestOf(bank({ manifest: awaiting, landing: awaiting }))).toBe(true);
  });

  it("holds with nothing more to say for a BANK.md valid on main", async () => {
    expect(await manifestOf(bank({}))).toBe(true);
  });
});
