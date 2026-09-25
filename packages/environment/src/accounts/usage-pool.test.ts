import type { AccountRecord, AccountUsage, UsageWindow } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock } from "../../test/clock.js";
import { fakeAdapter, usageOf, usageWindow } from "../../test/fake-adapter.js";
import { openEventLog } from "../event-log/event-log.js";
import type { AccountFacts } from "../runs/run-decider.js";
import { createUsagePool, foldVerdict, sameReading, type PlanVerdict } from "./usage-pool.js";

/**
 * The pool's fold and its notice rule as pure functions: a run's verdict
 * folded into a reading, ported from Artemis's `applyPlanLimit` cases
 * (`packages/protocol/src/usage.test.ts` at 443cf2e, "applyPlanLimit" and
 * "a window keeps the clock it was read on"), and what counts as a change.
 * The pool's own reads, sharing and notices are the wire's
 * (`usage.test.ts`); a fault around a read, which the wire cannot stage, is
 * the pool's own, below.
 */

const { onCleanup } = useCleanups();

const READ = Date.parse("2026-09-24T01:00:00.000Z");
const iso = (ms: number): string => new Date(ms).toISOString();

const w = (window: string, utilisation: number | null, extra: Partial<UsageWindow> = {}): UsageWindow => ({
  window,
  utilisation,
  resetsAt: null,
  verdict: null,
  observedAt: iso(READ),
  ...extra,
});

const reading = (windows: readonly UsageWindow[], extra: Partial<AccountUsage> = {}): AccountUsage => ({
  accountId: "work",
  identity: { provider: "claude", email: "david@example.com", organisation: null },
  windows: [...windows],
  readAt: iso(READ),
  unavailableReason: null,
  ...extra,
});

const verdict = (window: string, status: PlanVerdict["status"], at: number, named: Partial<Pick<PlanVerdict, "utilisation" | "resetsAt">> = {}): PlanVerdict => ({
  window,
  status,
  utilisation: named.utilisation ?? null,
  resetsAt: named.resetsAt ?? null,
  at: iso(at),
});

const polled = reading([w("five_hour", 0.33), w("seven_day", 0.97)]);
const windowOf = (usage: AccountUsage | null, name: string): UsageWindow | undefined => usage?.windows.find((window) => window.window === name);

describe("foldVerdict", () => {
  it("marks the named window and dates it by the verdict, the read's number standing and the other window untouched", () => {
    const folded = foldVerdict(polled, verdict("seven_day", "rejected", READ + 5_000));
    expect(windowOf(folded, "seven_day")).toEqual({ window: "seven_day", utilisation: 0.97, resetsAt: null, verdict: "rejected", observedAt: iso(READ + 5_000) });
    expect(windowOf(folded, "five_hour")).toEqual(w("five_hour", 0.33));
    // The reading is no younger for it: the read is when its numbers were true.
    expect(folded?.readAt).toBe(polled.readAt);
  });

  it("is not news when nothing changed: an allowed on a window with no verdict, the same verdict twice", () => {
    expect(foldVerdict(polled, verdict("five_hour", "allowed", READ + 1))).toBeNull();
    const refused = foldVerdict(polled, verdict("seven_day", "rejected", READ + 1));
    expect(refused).not.toBeNull();
    expect(foldVerdict(refused as AccountUsage, verdict("seven_day", "rejected", READ + 2))).toBeNull();
  });

  it("clears a held verdict when the provider allows again", () => {
    const refused = foldVerdict(polled, verdict("five_hour", "rejected", READ + 1)) as AccountUsage;
    expect(windowOf(foldVerdict(refused, verdict("five_hour", "allowed", READ + 2)), "five_hour")?.verdict).toBe("allowed");
  });

  it("carries a utilisation and a reset when the report has them", () => {
    const folded = foldVerdict(polled, verdict("five_hour", "warning", READ + 1, { utilisation: 0.91, resetsAt: iso(READ + 60_000) }));
    expect(windowOf(folded, "five_hour")).toMatchObject({ utilisation: 0.91, resetsAt: iso(READ + 60_000), verdict: "warning" });
  });

  it("adds a window the read did not report", () => {
    expect(windowOf(foldVerdict(polled, verdict("model_scoped:Fable", "warning", READ + 1)), "model_scoped:Fable")).toEqual({
      window: "model_scoped:Fable",
      utilisation: null,
      resetsAt: null,
      verdict: "warning",
      observedAt: iso(READ + 1),
    });
  });

  it("replaces an unavailable reading rather than merging into it: the provider has just said it limits the account", () => {
    const metered = reading([], { unavailableReason: "No plan limits were reported for this account." });
    const folded = foldVerdict(metered, verdict("five_hour", "rejected", READ + 1));
    expect(folded).toMatchObject({ unavailableReason: null, windows: [{ window: "five_hour", verdict: "rejected" }] });
  });

  it("does not fold a verdict older than the read, whose numbers are newer, so no window is observed before its reading", () => {
    expect(foldVerdict(polled, verdict("five_hour", "rejected", READ - 1))).toBeNull();
    expect(foldVerdict(polled, verdict("five_hour", "rejected", READ))).not.toBeNull();
  });
});

describe("a window keeps the clock it was read on", () => {
  it("is not re-dated by a verdict about a different window", () => {
    const folded = foldVerdict(polled, verdict("seven_day", "warning", READ + 1_000));
    expect(windowOf(folded, "seven_day")?.observedAt).toBe(iso(READ + 1_000));
    expect(windowOf(folded, "five_hour")?.observedAt).toBe(iso(READ));
  });

  it("does not carry a number across a reset a verdict announces", () => {
    const reset = READ + 10_000;
    const spent = reading([w("five_hour", 0.97, { resetsAt: iso(reset), verdict: "rejected" })]);
    const window = windowOf(foldVerdict(spent, verdict("five_hour", "allowed", reset + 1)), "five_hour");
    expect(window).toMatchObject({ verdict: "allowed", utilisation: null, resetsAt: null, observedAt: iso(reset + 1) });
  });

  it("keeps a number the verdict brought with it across the same reset", () => {
    const reset = READ + 10_000;
    const spent = reading([w("five_hour", 0.97, { resetsAt: iso(reset), verdict: "rejected" })]);
    const next = iso(reset + 5 * 3_600_000);
    expect(windowOf(foldVerdict(spent, verdict("five_hour", "allowed", reset + 1, { utilisation: 0.04, resetsAt: next })), "five_hour")).toMatchObject({
      utilisation: 0.04,
      resetsAt: next,
    });
  });
});

describe("sameReading, the notice rule", () => {
  it("is a change when a window's utilisation moves a whole percent, its reset or verdict moves, or the reason or identity does", () => {
    expect(sameReading(polled, reading([w("five_hour", 0.334), w("seven_day", 0.97)]))).toBe(true);
    expect(sameReading(polled, reading([w("five_hour", 0.34), w("seven_day", 0.97)]))).toBe(false);
    expect(sameReading(polled, reading([w("five_hour", 0.33, { verdict: "warning" }), w("seven_day", 0.97)]))).toBe(false);
    expect(sameReading(polled, reading([w("five_hour", 0.33, { resetsAt: iso(READ) }), w("seven_day", 0.97)]))).toBe(false);
    expect(sameReading(polled, { ...polled, identity: null })).toBe(false);
    expect(sameReading(polled, reading([w("five_hour", 0.33)]))).toBe(false);
  });

  it("is no change when only the times moved", () => {
    expect(sameReading(polled, reading([w("five_hour", 0.33, { observedAt: iso(READ + 60_000) }), w("seven_day", 0.97)], { readAt: iso(READ + 60_000) }))).toBe(true);
  });
});

describe("a fault around one account's read", () => {
  it("answers that account unavailable and reported, the other read as ever, rather than failing the batch", async () => {
    const clock = manualClock();
    const log = openEventLog({ path: ":memory:", clock: () => clock.now() });
    onCleanup(() => log.close());
    const record = (id: string): AccountRecord => ({
      id,
      provider: "fake",
      label: id,
      directory: { kind: "adopted", path: `/nonexistent/${id}` },
      identity: { provider: "fake", email: `${id}@example.com`, organisation: null },
      status: { state: "signed-in", checkedAt: null, detail: null },
      createdAt: clock.now().toISOString(),
    });
    const { descriptor } = fakeAdapter({ clock });
    const facts = (id: string): AccountFacts => ({ id, directory: `/nonexistent/${id}`, signedIn: true, identity: null, descriptor, models: [] });
    const pool = createUsagePool({
      log,
      clock,
      environmentId: "environment",
      accounts: { list: () => [record("work"), record("broken")] },
      host: {
        // The seam outside the adapter's read: the host's account lookup throws for one account.
        account: (id) => {
          if (id === "broken") throw new Error("The account table is locked.");
          return facts(id ?? "work");
        },
        usage: async (id) => usageOf(`${id}@example.com`, [usageWindow("five_hour", 0.4)], clock.now()),
      },
    });
    onCleanup(() => pool.close());
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    onCleanup(() => reported.mockRestore());

    const readings = await pool.read();
    expect(readings.map((reading) => reading.accountId)).toEqual(["work", "broken"]);
    expect(readings[0]).toMatchObject({ unavailableReason: null, windows: [{ window: "five_hour", utilisation: 0.4 }] });
    expect(readings[1]).toMatchObject({ windows: [], unavailableReason: "Could not read plan usage: The account table is locked." });
    expect(await pool.read("broken")).toEqual([expect.objectContaining({ accountId: "broken", windows: [] })]);
    expect(reported).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.any(Error));
  });
});
