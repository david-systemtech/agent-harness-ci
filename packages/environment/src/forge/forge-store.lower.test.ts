import {
  ForgeAccountRecord,
  UNKNOWN_FORGE_CAPABILITIES,
  type ForgeAccountAddedPayload,
  type ForgeAccountCapabilityLearnedPayload,
  type ForgeAccountVerifiedPayload,
} from "@agent-harness/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { manualClock } from "../../test/clock.js";
import { openEventLog, type EventLog } from "../event-log/event-log.js";
import { forgeAccountsProjector, listForgeAccounts } from "./forge-store.js";

/**
 * The forge account store's projector at the lower seam, for the events no
 * wire method appends yet: a verification's findings (#311) and a
 * capability an operation showed (#316) change the record, and a git
 * rejection and a missing origin change none. The events are appended as
 * the ForgeService will append them, as `system:forge`.
 */

let logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs) log.close();
  logs = [];
});

const forgeAccountId = "5b1c6f3e-2a4d-4e8f-9b0a-1c2d3e4f5a6b";
const origin = "https://git.systemtech.dev:5526";
const environment = { kind: "environment", id: "0f8fad5b-d9cb-469f-a165-70867728950e" };
const actor = "system:forge";

const addedPayload: ForgeAccountAddedPayload = {
  forgeAccountId,
  origin,
  aliases: [],
  kind: "forgejo",
  slug: "git_systemtech_dev",
  identity: null,
  credential: { kind: "stored", provenance: "pasted", entry: `forge:${forgeAccountId}:7c9e6679-7425-40de-944b-e07fc1f90ae7` },
  primary: true,
  clearedPrimary: null,
  problem: { kind: "unreachable", since: "2026-09-24T00:00:00.000Z", message: "The forge did not answer." },
  copiedFrom: null,
};

const storeWithOne = () => {
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", projectors: [forgeAccountsProjector], clock: () => clock.now() });
  logs.push(log);
  log.append(environment, [{ type: "forge.account.added", payload: addedPayload }], { actor });
  const read = () => listForgeAccounts({ all: (sql, ...params) => log.read(sql, ...params) });
  return { log, clock, read };
};

describe("the forge account store's projector", () => {
  it("takes a verification's findings whole: identity, capabilities, token information and problem", () => {
    const { log, read } = storeWithOne();
    const verified: ForgeAccountVerifiedPayload = {
      forgeAccountId,
      identity: { login: "david", userId: "42" },
      capabilities: { ...UNKNOWN_FORGE_CAPABILITIES, readRepository: { state: "verified", verifiedAt: "2026-09-24T00:00:00.000Z", status: null } },
      tokenInformation: { kind: "unknown", scopes: null, expiresAt: null },
      problem: null,
    };
    log.append(environment, [{ type: "forge.account.verified", payload: verified }], { actor });

    const [account] = read();
    expect(ForgeAccountRecord.parse(account)).toMatchObject({
      identity: verified.identity,
      capabilities: verified.capabilities,
      tokenInformation: verified.tokenInformation,
      problem: null,
    });
  });

  it("marks a capability an operation showed verified at the event's time, or failed with its status keeping when it was last verified", () => {
    const { log, clock, read } = storeWithOne();
    const learned = (state: "verified" | "failed", status: number | null): ForgeAccountCapabilityLearnedPayload => ({
      forgeAccountId,
      capability: "writeIssues",
      state,
      operation: "open an issue",
      status,
    });
    log.append(environment, [{ type: "forge.account.capability-learned", payload: learned("verified", 201) }], { actor });
    expect(read()[0]?.capabilities.writeIssues).toEqual({ state: "verified", verifiedAt: "2026-09-24T00:00:00.000Z", status: null });

    clock.advance(60_000);
    log.append(environment, [{ type: "forge.account.capability-learned", payload: learned("failed", 403) }], { actor });
    expect(read()[0]?.capabilities).toEqual({ ...UNKNOWN_FORGE_CAPABILITIES, writeIssues: { state: "failed", verifiedAt: "2026-09-24T00:00:00.000Z", status: 403 } });
  });

  it("changes no record on a git rejection or a missing origin", () => {
    const { log, read } = storeWithOne();
    const before = read();
    log.append(
      environment,
      [
        { type: "forge.account.git-rejected", payload: { forgeAccountId, origin } },
        { type: "forge.origin-missing", payload: { origin: "https://codeberg.org", operation: "clone a skill source" } },
      ],
      { actor },
    );
    expect(read()).toEqual(before);
  });
});
