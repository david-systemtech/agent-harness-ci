import { randomUUID } from "node:crypto";
import { registry, type AccountUsage, type EventFrame, type HandoffRecommendation, type UsageUpdatedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock, type ManualClock } from "../../test/clock.js";
import {
  end,
  fakeAdapter,
  gate,
  planLimit,
  presetUsage,
  say,
  signedInAs,
  usageOf,
  usageWindow,
  type FakeAdapter,
  type FakeAdapterOptions,
  type UsageScript,
} from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { USAGE_MAX_AGE_MS } from "./handoff.js";

/**
 * Plan usage and the hand-off recommendation through the primary seam
 * (claude-adapter spec, "Plan usage", "Wire methods" and "Testing
 * Decisions"; ADR 0005, ADR 0018): an in-process environment with the fake
 * adapter's usage read scripted per account, a real client over a real
 * WebSocket, and the manual clock for the six-minute ageing. Readings with
 * their identity, one read shared by concurrent asks, ageing, a run's
 * `plan.limit` folded in, the `usage.updated` notice, an unavailable read,
 * the recommendation from cached readings and its change when a window runs
 * out, and one identity on two environments reading equal.
 */

const { onCleanup } = useCleanups();

const RESETS = "2026-09-24T05:00:00.000Z";

/** Two accounts, each in a directory of its own, carried over from configuration as the helper's `claude-max` is. */
const ACCOUNTS = [
  { id: "work", provider: "fake", directory: "/nonexistent/accounts/work" },
  { id: "personal", provider: "fake", directory: "/nonexistent/accounts/personal" },
];

/** A usage read giving each account the 5-hour utilisation `byAccount` names (a quarter unless named), read now. */
const fiveHour =
  (byAccount: Record<string, number>): UsageScript =>
  (account, now) =>
    usageOf(`${account.id}@example.com`, [usageWindow("five_hour", byAccount[account.id] ?? 0.25, RESETS)], now);

interface Started {
  readonly t: TestEnvironment;
  readonly clock: ManualClock;
  readonly adapter: FakeAdapter;
  readonly client: WireClient;
}

const start = async (fake: FakeAdapterOptions = {}, accounts = ACCOUNTS): Promise<Started> => {
  const clock = manualClock();
  const adapter = fakeAdapter({ clock, ...fake });
  const t = await startTestEnvironment({ clock, adapter, accounts });
  onCleanup(() => t.close());
  return { t, clock, adapter, client: await t.client() };
};

/** `accounts.usage`, checked against its result schema. */
const usage = async (client: WireClient, accountId?: string): Promise<AccountUsage[]> =>
  registry["accounts.usage"].result.parse(await client.request("accounts.usage", accountId === undefined ? {} : { accountId })).readings;

const reading = async (client: WireClient, accountId: string): Promise<AccountUsage> => {
  const [found] = await usage(client, accountId);
  if (found === undefined) throw new Error(`accounts.usage answered no reading for ${accountId}.`);
  return found;
};

/** `accounts.handoff.recommend`, checked against its result schema. */
const recommend = async (client: WireClient, fromAccountId?: string): Promise<HandoffRecommendation> =>
  registry["accounts.handoff.recommend"].result.parse(await client.request("accounts.handoff.recommend", fromAccountId === undefined ? {} : { fromAccountId }));

/** The `usage.updated` notices on the environment's stream, in order. */
const notices = (t: TestEnvironment): UsageUpdatedPayload[] =>
  t.env.log
    .readStream({ kind: "environment", id: t.env.id })
    .filter((event) => event.type === "usage.updated")
    .map((event) => event.payload as UsageUpdatedPayload);

/** The adapter's usage reads of one account. */
const readsOf = (adapter: FakeAdapter, accountId: string): number => adapter.usageReads.filter((ref) => ref.id === accountId).length;

/** Starts a run on a new session of `account` and waits for it to end. */
const runOn = async (t: TestEnvironment, client: WireClient, account: string): Promise<void> => {
  const { id } = await create(client, { account });
  const answer = registry["runs.start"].response.parse(await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go" }));
  if (answer.result === undefined) throw new Error(`runs.start was not applied: ${JSON.stringify(answer.receipt)}`);
  const { runId } = answer.result;
  await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended" && event.payload["runId"] === runId)).toBe(true));
};

describe("accounts.usage", () => {
  it("answers each account's windows with its identity, as the store records it, through the wire", async () => {
    const { t, client } = await start({
      status: (account) => signedInAs(`${account.id}@example.com`, "Acme"),
      // The provider's own read names no organisation, and another case: the same login, so the store's identity is the one carried.
      usage: (account, now) =>
        usageOf(`${account.id.toUpperCase()}@example.com`, [usageWindow("five_hour", 0.4, RESETS), usageWindow("seven_day", 0.1, null), usageWindow("model_scoped:Fable", null, null)], now),
    });
    const at = t.clock.now().toISOString();
    const window = (name: string, utilisation: number | null, resetsAt: string | null) => ({ window: name, utilisation, resetsAt, verdict: null, observedAt: at });
    const expected = (accountId: string): AccountUsage => ({
      accountId,
      identity: { provider: "fake", email: `${accountId}@example.com`, organisation: "Acme" },
      windows: [window("five_hour", 0.4, RESETS), window("seven_day", 0.1, null), window("model_scoped:Fable", null, null)],
      readAt: at,
      unavailableReason: null,
    });
    expect(await usage(client)).toEqual([expected("work"), expected("personal")]);
    expect(await usage(client, "personal")).toEqual([expected("personal")]);
    expect(await refusal(client.request("accounts.usage", { accountId: "nobody" }))).toMatchObject({ code: "not_found", data: { kind: "account", accountId: "nobody" } });
  });

  it("shares one read of the adapter between two concurrent asks for one account", async () => {
    const held = gate();
    const { adapter, client, t } = await start({
      usage: async (account, now) => {
        await held.opened;
        return presetUsage(account, now);
      },
    });
    const other = await t.client();
    const first = client.request("accounts.usage", { accountId: "work" });
    const second = other.request("accounts.usage", { accountId: "work" });
    // Answered after both asks on each socket were dispatched: both are waiting on the one read now.
    await Promise.all([client.request("accounts.list", {}), other.request("accounts.list", {})]);
    await vi.waitFor(() => expect(readsOf(adapter, "work")).toBe(1));
    held.open();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(readsOf(adapter, "work")).toBe(1);
  });

  it("keeps a reading for six minutes from when the provider was read, and reads again after", async () => {
    const { adapter, client, clock } = await start();
    const first = await reading(client, "work");
    clock.advance(USAGE_MAX_AGE_MS - 1);
    expect(await reading(client, "work")).toEqual(first);
    expect(readsOf(adapter, "work")).toBe(1);
    clock.advance(1);
    const second = await reading(client, "work");
    expect(readsOf(adapter, "work")).toBe(2);
    expect(second.readAt).toBe(clock.now().toISOString());
    // The next ask within six minutes of that read shares it again.
    expect(await reading(client, "work")).toEqual(second);
    expect(readsOf(adapter, "work")).toBe(2);
  });

  it("ages a reading the adapter had already kept from when the provider was read, not from when the environment was given it", async () => {
    const { adapter, client, clock } = await start();
    // An adapter answering from its own cache (Claude's keeps a reading six minutes) hands over a reading four minutes old.
    const readAt = new Date(clock.now().getTime() - 4 * 60_000);
    adapter.setUsage((account) => presetUsage(account, readAt));
    expect((await reading(client, "work")).readAt).toBe(readAt.toISOString());
    clock.advance(2 * 60_000);
    adapter.setUsage(presetUsage);
    await reading(client, "work");
    expect(readsOf(adapter, "work")).toBe(2);
  });

  it("folds a run's plan.limit into the reading of that run's account, keeping what the verdict does not say", async () => {
    const { adapter, client, t } = await start({
      script: () => [planLimit("five_hour", "rejected", { resetsAt: "2026-09-24T04:00:00.000Z" }), say("Out of plan"), end()],
    });
    const before = await usage(client);
    const personalBefore = before.find((entry) => entry.accountId === "personal");
    await runOn(t, client, "work");
    const [work] = await usage(client, "work");
    const folded = t.env.log.readStream({ kinds: ["session"] }).find((event) => event.type === "plan.limit");
    expect(work?.windows).toEqual([{ window: "five_hour", utilisation: 0.25, resetsAt: "2026-09-24T04:00:00.000Z", verdict: "rejected", observedAt: folded?.occurredAt }]);
    expect(work?.readAt).toBe(before[0]?.readAt);
    // Folded, not read again; and the other account's reading is untouched.
    expect(readsOf(adapter, "work")).toBe(1);
    expect(await reading(client, "personal")).toEqual(personalBefore);
  });

  it("folds a verdict heard while a read is in flight into that read's reading, which began before it", async () => {
    const held = gate();
    const { adapter, client, t } = await start({
      usage: async (account, now) => {
        await held.opened;
        return presetUsage(account, now);
      },
      script: () => [planLimit("five_hour", "warning", { utilisation: 0.85 }), end()],
    });
    const pending = client.request("accounts.usage", { accountId: "work" });
    await vi.waitFor(() => expect(readsOf(adapter, "work")).toBe(1));
    const other = await t.client();
    await runOn(t, other, "work");
    held.open();
    const answered = registry["accounts.usage"].result.parse(await pending).readings[0];
    expect(answered?.windows[0]).toMatchObject({ window: "five_hour", utilisation: 0.85, verdict: "warning", resetsAt: RESETS });
    expect((await reading(client, "work")).windows[0]).toMatchObject({ utilisation: 0.85, verdict: "warning" });
  });

  it("drops a verdict for an account with no reading to fold into, since the next read is newer", async () => {
    const { adapter, client, t } = await start({ script: () => [planLimit("five_hour", "rejected"), end()] });
    await runOn(t, client, "work");
    expect(notices(t)).toEqual([]);
    expect((await reading(client, "work")).windows[0]?.verdict).toBeNull();
    expect(readsOf(adapter, "work")).toBe(1);
  });

  describe("when the usage cannot be read", () => {
    it("answers an adapter without the planUsage capability with a reading that says so", async () => {
      const { adapter, client } = await start({ capabilities: { planUsage: false } });
      const [work] = await usage(client, "work");
      expect(work).toMatchObject({ accountId: "work", identity: { email: "work@example.com" }, windows: [], unavailableReason: expect.stringMatching(/does not report plan usage/) });
      expect(adapter.usageReads).toEqual([]);
    });

    it("answers a failed read with the reason rather than failing the call, and reads again on the next ask", async () => {
      const { adapter, client } = await start();
      adapter.setUsage(() => {
        throw new Error("The usage endpoint is down.");
      });
      expect(await reading(client, "work")).toMatchObject({ windows: [], unavailableReason: expect.stringContaining("The usage endpoint is down.") });
      adapter.setUsage(presetUsage);
      expect((await reading(client, "work")).windows).toHaveLength(1);
      expect(readsOf(adapter, "work")).toBe(2);
    });

    it("passes on the provider's own reason for reporting no windows", async () => {
      const { adapter, client } = await start();
      adapter.setUsage((account, now) => ({ ...usageOf(`${account.id}@example.com`, [], now), unavailableReason: "No plan limits apply to an API-key login." }));
      expect(await reading(client, "work")).toMatchObject({ windows: [], unavailableReason: "No plan limits apply to an API-key login." });
    });

    it("does not read an account that is not signed in, and says why", async () => {
      const { adapter, client } = await start({ status: (account) => signedInAs(account.id === "work" ? null : `${account.id}@example.com`) });
      expect(await reading(client, "work")).toMatchObject({ identity: null, windows: [], unavailableReason: expect.stringMatching(/signed-out/) });
      expect(readsOf(adapter, "work")).toBe(0);
    });
  });
});

describe("usage.updated", () => {
  it("goes out on environment.subscribe when a reading changes, and not when a read finds it as it was", async () => {
    const { adapter, client, clock, t } = await start();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    await reading(client, "work");
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(frame.event).toMatchObject({
      streamKind: "environment",
      type: "usage.updated",
      payload: { accountId: "work", identity: { provider: "fake", email: "work@example.com", organisation: null } },
    });
    // Read again six minutes on, as it was: nothing to say.
    clock.advance(USAGE_MAX_AGE_MS);
    await reading(client, "work");
    expect(readsOf(adapter, "work")).toBe(2);
    expect(notices(t)).toHaveLength(1);
    // Read again with the window moved.
    clock.advance(USAGE_MAX_AGE_MS);
    adapter.setUsage(fiveHour({ work: 0.5 }));
    await reading(client, "work");
    expect(notices(t)).toEqual([expect.objectContaining({ accountId: "work" }), expect.objectContaining({ accountId: "work" })]);
  });

  it("goes out for a run's verdict that is news, once, and not for one that repeats it", async () => {
    const { client, t } = await start({ script: () => [planLimit("five_hour", "warning", { utilisation: 0.8 }), planLimit("five_hour", "warning", { utilisation: 0.8 }), end()] });
    await reading(client, "work");
    expect(notices(t)).toHaveLength(1);
    await runOn(t, client, "work");
    await vi.waitFor(() => expect(notices(t)).toHaveLength(2));
    expect((await reading(client, "work")).windows[0]).toMatchObject({ utilisation: 0.8, verdict: "warning" });
    expect(notices(t)).toHaveLength(2);
  });
});

describe("accounts.handoff.recommend", () => {
  it("answers from the readings the environment holds, never reading a provider", async () => {
    const { adapter, client } = await start();
    expect(await recommend(client)).toEqual({
      accountId: null,
      reason: "no-target",
      message: expect.any(String),
      fromAccountId: null,
      trigger: null,
      headroom: null,
      binding: null,
      candidates: 0,
      basis: null,
    });
    expect(adapter.usageReads).toEqual([]);
  });

  it("recommends the account with the most room, the same to two clients, and changes when its window runs out", async () => {
    const { client, t } = await start({ usage: fiveHour({ work: 0.5, personal: 0.3 }), script: () => [planLimit("five_hour", "rejected"), end()] });
    await usage(client);
    const other = await t.client();
    const first = await recommend(client);
    expect(first).toMatchObject({ accountId: "personal", reason: "most-room", candidates: 2, binding: "five_hour", basis: "percentage", fromAccountId: null, trigger: null });
    expect(first.headroom).toBeCloseTo(0.7);
    expect(await recommend(other)).toEqual(first);
    // Personal's 5-hour window runs out: the provider refuses it now.
    await runOn(t, client, "personal");
    const after = await recommend(client);
    expect(after).toMatchObject({ accountId: "work", reason: "most-room", candidates: 2 });
    expect(after.headroom).toBeCloseTo(0.5);
    expect(await recommend(other)).toEqual(after);
  });

  it("from an account near its limit, names the threshold it met and the other account to hand to", async () => {
    const { client } = await start({ usage: fiveHour({ work: 0.94, personal: 0.3 }) });
    await usage(client);
    const answer = await recommend(client, "work");
    expect(answer).toMatchObject({
      accountId: "personal",
      reason: "limit-near",
      fromAccountId: "work",
      trigger: { threshold: "five_hour", label: "5-hour", at: 0.9, window: "five_hour", utilisation: 0.94, verdict: null },
      candidates: 1,
    });
    expect(answer.message).toMatch(/work/);
    expect(answer.message).toMatch(/personal/);
  });

  it("from an account the provider is refusing, says it has reached its limit, and never names a refused account to hand to", async () => {
    const { client, t } = await start({ usage: fiveHour({ work: 0.4, personal: 0.3 }), script: () => [planLimit("five_hour", "rejected"), end()] });
    await usage(client);
    await runOn(t, client, "work");
    expect(await recommend(client, "work")).toMatchObject({ accountId: "personal", reason: "limit-reached", trigger: { window: "five_hour", verdict: "rejected" } });
    await runOn(t, client, "personal");
    expect(await recommend(client, "work")).toMatchObject({ accountId: null, reason: "no-target", trigger: { verdict: "rejected" }, candidates: 0 });
  });

  it("from an account with room, still names the other account with the most room, with no threshold met", async () => {
    const { client } = await start({ usage: fiveHour({ work: 0.2, personal: 0.3 }) });
    await usage(client);
    expect(await recommend(client, "work")).toMatchObject({ accountId: "personal", reason: "most-room", trigger: null, candidates: 1 });
    expect(await refusal(client.request("accounts.handoff.recommend", { fromAccountId: "nobody" }))).toMatchObject({ code: "not_found", data: { kind: "account" } });
  });

  it("does not recommend on readings older than six minutes", async () => {
    const { client, clock } = await start({ usage: fiveHour({ work: 0.5, personal: 0.3 }) });
    await usage(client);
    clock.advance(USAGE_MAX_AGE_MS + 1);
    expect(await recommend(client)).toMatchObject({ accountId: null, reason: "no-target" });
  });

  it("counts the runs live on an account against its room", async () => {
    const running = gate();
    const { client, t } = await start({
      usage: fiveHour({ work: 0.3, personal: 0.3 }),
      script: async function* () {
        yield say("Working");
        await running.opened;
        yield end();
      },
    });
    onCleanup(() => running.open());
    await usage(client);
    expect((await recommend(client)).accountId).toBe("work");
    const { id } = await create(client, { account: "work", model: "opus" });
    await client.request("runs.start", { commandId: randomUUID(), sessionId: id, text: "Go", effort: "max" });
    await vi.waitFor(async () => expect((await recommend(client)).accountId).toBe("personal"));
    running.open();
    await vi.waitFor(() => expect(t.env.log.readStream({ kind: "session", id }).some((event) => event.type === "run.ended")).toBe(true));
    expect((await recommend(client)).accountId).toBe("work");
  });
});

describe("one identity on two environments", () => {
  it("reads as an equal identity on each, so a client pools the two readings into one gauge", async () => {
    const david = (account: { readonly id: string }, now: Date) => usageOf(account.id === "laptop-max" ? "David@Example.com" : "david@example.com", [usageWindow("five_hour", 0.3, RESETS)], now);
    const laptop = await start({ status: () => signedInAs("david@example.com", "Acme"), usage: david }, [{ id: "laptop-max", provider: "fake", directory: "/nonexistent/laptop" }]);
    const server = await start({ status: () => signedInAs("david@example.com", "Acme"), usage: david }, [{ id: "server-max", provider: "fake", directory: "/nonexistent/server" }]);
    const [onLaptop] = await usage(laptop.client);
    const [onServer] = await usage(server.client);
    expect(onLaptop?.accountId).not.toBe(onServer?.accountId);
    expect(onLaptop?.identity).toEqual({ provider: "fake", email: "david@example.com", organisation: "Acme" });
    expect(onServer?.identity).toEqual(onLaptop?.identity);
    expect(laptop.t.env.id).not.toBe(server.t.env.id);
  });
});
