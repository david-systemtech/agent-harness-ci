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
import { forgeAccountsProjector, listForgeAccounts, originHolder } from "./forge-store.js";

/**
 * The forge account store's projector at the lower seam, for what no wire
 * method appends yet: an alias holds its origin as the canonical origin
 * does, a verification's findings (#311) and a capability an operation
 * showed (#316) change the record, and a git rejection and a missing origin
 * change none. The events are appended as the ForgeService will append
 * them, as `system:forge`.
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
  const reader = { all: <Row>(sql: string, ...params: readonly (string | number | null)[]) => log.read<Row>(sql, ...params) };
  return { log, clock, reader, read: () => listForgeAccounts(reader) };
};

describe("the forge account store's projector", () => {
  it("holds an alias's origin for its forge account as it holds the canonical origin, until the forge account is removed", () => {
    const { log, reader } = storeWithOne();
    const alias = "http://100.101.102.103:3000";
    log.append(environment, [{ type: "forge.account.updated", payload: { forgeAccountId, aliases: [{ origin: alias, verifiedAt: null }] } }], { actor });
    expect([originHolder(reader, origin), originHolder(reader, alias)]).toEqual([forgeAccountId, forgeAccountId]);
    log.append(environment, [{ type: "forge.account.removed", payload: { forgeAccountId } }], { actor });
    expect([originHolder(reader, origin), originHolder(reader, alias)]).toEqual([null, null]);
  });

  it("injects nothing for a forge account whose problem is identity-changed, until a verification clears it", () => {
    const { log, read } = storeWithOne();
    const verified = (problem: ForgeAccountVerifiedPayload["problem"]): ForgeAccountVerifiedPayload => ({
      forgeAccountId,
      identity: { login: "david", userId: "42" },
      capabilities: UNKNOWN_FORGE_CAPABILITIES,
      tokenInformation: null,
      problem,
    });
    log.append(environment, [{ type: "forge.account.verified", payload: verified({ kind: "identity-changed", since: "2026-09-24T00:00:00.000Z", message: "Another user answered." }) }], {
      actor,
    });
    expect(read()[0]?.variables).toEqual({ url: [], token: [], kind: [] });
    log.append(environment, [{ type: "forge.account.verified", payload: verified(null) }], { actor });
    expect(read()[0]?.variables.token).toEqual(["FORGE_GIT_SYSTEMTECH_DEV_TOKEN", "FORGE_TOKEN"]);
  });

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

  it("keeps when the status last changed: the problem's since-time, else when it was last cleared, unmoved by findings that keep the problem's kind", () => {
    const { log, clock, read } = storeWithOne();
    const since = "2026-09-24T00:00:00.000Z";
    expect(read()[0]?.statusSince).toBe(since);
    const verified = (problem: ForgeAccountVerifiedPayload["problem"], login = "david"): ForgeAccountVerifiedPayload => ({
      forgeAccountId,
      identity: { login, userId: "42" },
      capabilities: UNKNOWN_FORGE_CAPABILITIES,
      tokenInformation: null,
      problem,
    });

    // Still unreachable, found again later: the status has held since the add.
    clock.advance(60_000);
    log.append(environment, [{ type: "forge.account.verified", payload: verified({ kind: "unreachable", since, message: "Still no answer." }) }], { actor });
    expect(read()[0]?.statusSince).toBe(since);
    // Cleared: verified since now, and a later change of login keeps it.
    clock.advance(60_000);
    log.append(environment, [{ type: "forge.account.verified", payload: verified(null) }], { actor });
    expect(read()[0]?.statusSince).toBe("2026-09-24T00:02:00.000Z");
    clock.advance(60_000);
    log.append(environment, [{ type: "forge.account.verified", payload: verified(null, "david-renamed") }], { actor });
    expect(read()[0]?.statusSince).toBe("2026-09-24T00:02:00.000Z");
    // A new problem: its own since-time, which a replaced credential's answer clears again.
    const expiring = { kind: "expiring", since: "2026-09-24T00:03:30.000Z", message: "The token expires soon." } as const;
    log.append(environment, [{ type: "forge.account.verified", payload: verified(expiring) }], { actor });
    expect(read()[0]?.statusSince).toBe(expiring.since);
    clock.advance(120_000);
    log.append(environment, [{ type: "forge.account.updated", payload: { forgeAccountId, slug: "work" } }], { actor });
    expect(read()[0]?.statusSince).toBe(expiring.since);
    log.append(environment, [{ type: "forge.account.updated", payload: { forgeAccountId, credential: addedPayload.credential, problem: null } }], { actor });
    expect(read()[0]?.statusSince).toBe("2026-09-24T00:05:00.000Z");
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
