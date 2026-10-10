import { expect, it, vi } from "vitest";
import type { Adapter, AccountRef, ModelCatalogue } from "../adapter/contract.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { manualClock } from "../../test/clock.js";
import { openEventLog } from "../event-log/event-log.js";
import { createAccountService } from "./account-service.js";
import { accountStateChecks } from "./step-checks.js";
import { accountsProjector } from "./account-store.js";
import { ProbeTimeoutError } from "../adapter/probe.js";

it("does not postpone status recovery when an uncached model catalogue is requested", async () => {
  vi.useFakeTimers();
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: () => clock.now(), projectors: [accountsProjector] });
  let held = true;
  const status = vi.fn(async (_account: AccountRef, signal?: AbortSignal) => {
    if (!held) return signedInAs("one@example.com");
    return new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const service = createAccountService({ log, clock, environmentId: "test-environment", ownedRoot: null,
    configured: [{ id: "one", provider: "fake" }], adapters: [{ ...fakeAdapter(), status,
      models: async () => { throw new ProbeTimeoutError("The model catalogue is temporarily unavailable."); },
    }] });
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(service.list()[0]?.status.state).toBe("unavailable");
    held = false;
    clock.advance(20_000);
    await service.catalogues("one");
    clock.advance(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.list()[0]?.status.state).toBe("signed-in");
    expect(status).toHaveBeenCalledTimes(2);
  } finally { service.close(); log.close(); diagnostics.mockRestore(); vi.useRealTimers(); }
});

it("cancels both startup probes at the outer deadline, records temporary unavailability and recovers without signing in", async () => {
  vi.useFakeTimers();
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: () => clock.now(), projectors: [accountsProjector] });
  const cancelled: string[] = [];
  let held = false;
  const hold = <T>(kind: string, account: AccountRef, signal?: AbortSignal): Promise<T> => new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => { cancelled.push(`${kind}:${account.id}`); reject(signal.reason); }, { once: true });
    // A provider's later inner deadline must never create a second diagnostic or overwrite recovery.
    setTimeout(() => reject(new Error("inner deadline")), 15_000);
  });
  const adapter: Adapter = {
    ...fakeAdapter(),
    status: async (account, signal) => held ? hold("status", account, signal) : signedInAs(`${account.id}@example.com`),
    models: async (account, signal) => held ? hold<ModelCatalogue>("models", account, signal) : { live: true, models: [{ id: "model", family: "model", tier: 1, efforts: [] }] },
  };
  const options = { log, clock, environmentId: "test-environment", adapters: [adapter], ownedRoot: null, configured: [{ id: "one", provider: "fake" }, { id: "two", provider: "fake" }] };
  let service = createAccountService(options);
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await service.start();
    expect(service.list().map(account => account.status.state)).toEqual(["signed-in", "signed-in"]);
    service.close();
    held = true;
    service = createAccountService(options);
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await starting;
    expect(cancelled.sort()).toEqual(["models:one", "models:two", "status:one", "status:two"]);
    expect(service.list().map(account => account.status)).toEqual([
      expect.objectContaining({ state: "unavailable", detail: expect.stringContaining("retry") }),
      expect.objectContaining({ state: "unavailable", detail: expect.stringContaining("retry") }),
    ]);
    expect(service.facts("one")?.signedIn).toBe(false);
    expect(accountStateChecks({ accounts: () => service.list() })["account.signed-in"]({ maxAgeMs: 0 })).toMatchObject({
      reason: expect.stringContaining("Temporarily unavailable"), actions: ["check-again"],
    });
    // A second slow read retains the temporary state and schedules another bounded retry.
    clock.advance(30_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.list().map((account) => account.status.state)).toEqual(["unavailable", "unavailable"]);
    expect(cancelled).toHaveLength(8);
    held = false;
    clock.advance(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.list().map(account => account.status.state)).toEqual(["signed-in", "signed-in"]);
    expect((await service.catalogues()).map(catalogue => catalogue.live)).toEqual([true, true]);
    const count = diagnostics.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(diagnostics.mock.calls.length).toBe(count);
    expect(service.list().map(account => account.status.state)).toEqual(["signed-in", "signed-in"]);
  } finally {
    service.close(); log.close(); diagnostics.mockRestore(); vi.useRealTimers();
  }
});

it("cancels outstanding account probes on close without recording a sign-in error or retrying", async () => {
  vi.useFakeTimers();
  const clock = manualClock();
  const log = openEventLog({ path: ":memory:", clock: () => clock.now(), projectors: [accountsProjector] });
  const cancelled: string[] = [];
  const hold = (kind: string, signal?: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => { cancelled.push(kind); reject(signal.reason); }, { once: true });
  });
  const service = createAccountService({ log, clock, environmentId: "test-environment", ownedRoot: null,
    configured: [{ id: "one", provider: "fake" }], adapters: [{ ...fakeAdapter(),
      status: (_account, signal) => hold("status", signal), models: (_account, signal) => hold("models", signal),
    }] });
  const diagnostics = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const starting = service.start();
    await vi.advanceTimersByTimeAsync(0);
    service.close();
    await starting;
    expect(cancelled.sort()).toEqual(["models", "status"]);
    expect(service.list()[0]?.status.state).toBe("signed-out");
    expect(clock.pending()).toBe(0);
    expect(diagnostics).not.toHaveBeenCalled();
  } finally { service.close(); log.close(); diagnostics.mockRestore(); vi.useRealTimers(); }
});
