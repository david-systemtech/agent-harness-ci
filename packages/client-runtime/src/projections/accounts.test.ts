import { MODES, type AccountUsage } from "@agent-harness/contracts";
import { describe, expect, it, onTestFinished } from "vitest";
import { accountMethodFixtures } from "../../../contracts/test/account-fixtures.js";
import { scriptedEnvironments, type ScriptedEnvironment } from "../../test/environments.js";
import { noticeEvent } from "../../test/events.js";
import { writable } from "../observable.js";
import type { CachedAnswer } from "../requests.js";
import { QUERY_REFRESH_NOTICES } from "../requests.js";
import { flush } from "../testing/fake-wire.js";
import { poolUsage, usageProjection } from "./accounts.js";
import { modePicker } from "./modes.js";

/**
 * `projections.accounts`, `projections.models` and `projections.usage`
 * (docs/specs/client-runtime.md, "Projections"; ADR 0005, ADR 0018): each
 * environment's accounts, models and plan usage read from the request
 * cache, fetched again on the notices that say they changed; plan usage
 * pooled by account identity, so one login on two environments is one
 * gauge. And the mode picker's ceiling beside the contracts' mode order
 * (ADR 0006).
 */

const accountsResult = () => structuredClone(accountMethodFixtures["accounts.list"]!.result.valid[1]) as { accounts: { id: string; label: string }[] };
const modelsResult = () => structuredClone(accountMethodFixtures["models.list"]!.result.valid[1]) as Record<string, unknown>;

describe("projections.accounts and projections.models", () => {
  it("read the environment's accounts and models from the request cache, and fetch them again when an account or a sign-in changes", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
    const [desk] = environments as [ScriptedEnvironment];
    const env = desk.wire.environmentId;
    let accounts = accountsResult();
    const asked: string[] = [];
    desk.wire.answer("accounts.list", () => {
      asked.push("accounts.list");
      return { result: accounts };
    });
    desk.wire.answer("models.list", () => {
      asked.push("models.list");
      return { result: modelsResult() };
    });
    const accountsView = runtime.projections.accounts(env);
    const modelsView = runtime.projections.models(env);
    expect(runtime.projections.accounts(env)).toBe(accountsView);
    onTestFinished(accountsView.subscribe(() => undefined));
    onTestFinished(modelsView.subscribe(() => undefined));
    await flush();
    expect(accountsView.read()).toMatchObject({ environmentId: env, value: accounts.accounts, error: null, loading: false });
    expect(modelsView.read()).toMatchObject({ environmentId: env, value: [expect.objectContaining({ live: true, models: [expect.objectContaining({ id: "opus" }), expect.anything()] })] });
    expect(asked.sort()).toEqual(["accounts.list", "models.list"]);

    // An account is relabelled: the notice fetches both again.
    accounts = { accounts: accounts.accounts.map((a, i) => (i === 0 ? { ...a, label: "Personal" } : a)) };
    desk.notices.event(noticeEvent(1, env, "account.updated", { accountId: accounts.accounts[0]!.id, change: "relabelled", warning: null }));
    await flush();
    expect(accountsView.read().value?.[0]).toMatchObject({ label: "Personal" });
    // A sign-in moving fetches them again as well.
    desk.notices.event(noticeEvent(2, env, "signin.updated", { accountId: accounts.accounts[0]!.id, state: "starting", url: null, startedAt: "2026-09-24T00:00:00.000Z", endedAt: null, message: null, fallback: null }));
    await flush();
    expect(asked.filter((method) => method === "accounts.list").length).toBeGreaterThanOrEqual(2);
  });

  it("read the same value until something changes, plan usage too while no environment serves it", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }, { name: "laptop" }] });
    const env = (environments[0] as ScriptedEnvironment).wire.environmentId;
    for (const view of [runtime.projections.usage, runtime.projections.accounts(env), runtime.projections.models(env), runtime.projections.modes(env), runtime.projections.runs]) {
      expect(view.read()).toBe(view.read());
    }
    onTestFinished(runtime.projections.usage.subscribe(() => undefined));
    await flush();
    expect(runtime.projections.usage.read()).toBe(runtime.projections.usage.read());
    expect(runtime.projections.usage.read().gauges).toEqual([]);
  });

  it("list the notices that refresh each query, plan usage's among them (#136)", () => {
    expect(QUERY_REFRESH_NOTICES["accounts.list"]).toEqual(["account.updated", "signin.updated"]);
    expect(QUERY_REFRESH_NOTICES["models.list"]).toEqual(["account.updated", "signin.updated"]);
    expect(QUERY_REFRESH_NOTICES["accounts.usage"]).toEqual(["usage.updated", "account.updated", "signin.updated"]);
    expect(QUERY_REFRESH_NOTICES["accounts.handoff.recommend"]).toEqual(["usage.updated", "account.updated", "signin.updated"]);
    expect(QUERY_REFRESH_NOTICES["accounts.signin.get"]).toEqual(["signin.updated"]);
  });

  it("keep the environment's sign-in in the request cache, fetched again as it moves, for a client attending it (#147)", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
    const [desk] = environments as [ScriptedEnvironment];
    const env = desk.wire.environmentId;
    const signIn = (state: string, url: string | null) => ({
      accountId: "account-1",
      state,
      url,
      startedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-24T00:10:00.000Z",
      fallback: { posix: "CLAUDE_CONFIG_DIR='/d' claude auth login", powershell: "$env:CLAUDE_CONFIG_DIR = '/d'; & 'claude' auth login" },
      error: null,
    });
    let held = signIn("starting", null);
    desk.wire.answer("accounts.signin.get", () => ({ result: { signIn: held } }));
    const view = runtime.requests.cached(env, "accounts.signin.get", {});
    onTestFinished(view.subscribe(() => undefined));
    await flush();
    expect(view.read().result?.signIn).toMatchObject({ state: "starting", url: null });
    // The URL is published: the notice carries the sign-in, and the cached answer is read again.
    held = signIn("awaiting-code", "https://claude.ai/oauth/authorize?code=true");
    desk.notices.event(noticeEvent(1, env, "signin.updated", held));
    await flush();
    expect(view.read().result?.signIn).toMatchObject({ state: "awaiting-code", url: "https://claude.ai/oauth/authorize?code=true" });
  });
});

// Plan usage, pooled by identity.

const david = { provider: "claude", email: "david@example.com", organisation: null };
const seth = { provider: "claude", email: "seth@example.com", organisation: "RX Ventures" };
const window = (name: string, utilisation: number, observedAt: string) => ({ window: name, utilisation, resetsAt: "2026-09-24T05:00:00.000Z", verdict: null, observedAt });
const reading = (accountId: string, identity: AccountUsage["identity"], readAt: string, windows: AccountUsage["windows"], unavailableReason: string | null = null): AccountUsage => ({
  accountId,
  identity,
  windows,
  readAt,
  unavailableReason,
});

describe("plan usage", () => {
  it("is one gauge for one identity on two environments, each window from whichever observed it last", () => {
    const gauges = poolUsage([
      {
        environmentId: "desk",
        readings: [reading("a-1", david, "2026-09-24T00:01:00.000Z", [window("five_hour", 0.4, "2026-09-24T00:01:00.000Z"), window("seven_day", 0.2, "2026-09-24T00:01:00.000Z")])],
      },
      {
        environmentId: "laptop",
        readings: [
          reading("b-7", david, "2026-09-24T00:00:30.000Z", [window("five_hour", 0.3, "2026-09-24T00:02:00.000Z"), window("seven_day", 0.1, "2026-09-24T00:00:30.000Z")]),
          reading("b-8", seth, "2026-09-24T00:00:10.000Z", [window("five_hour", 0.9, "2026-09-24T00:00:10.000Z")]),
        ],
      },
    ]);
    expect(gauges).toEqual([
      {
        identity: david,
        accounts: [
          { environmentId: "desk", accountId: "a-1" },
          { environmentId: "laptop", accountId: "b-7" },
        ],
        // The laptop's run reported the five-hour window after the desk's read; the desk read the seven-day one last.
        windows: [window("five_hour", 0.3, "2026-09-24T00:02:00.000Z"), window("seven_day", 0.2, "2026-09-24T00:01:00.000Z")],
        readAt: "2026-09-24T00:01:00.000Z",
        unavailableReason: null,
      },
      { identity: seth, accounts: [{ environmentId: "laptop", accountId: "b-8" }], windows: [window("five_hour", 0.9, "2026-09-24T00:00:10.000Z")], readAt: "2026-09-24T00:00:10.000Z", unavailableReason: null },
    ]);
  });

  it("gives a window observed at the same instant on two environments to the earlier one, whichever read last", () => {
    const [gauge] = poolUsage([
      { environmentId: "desk", readings: [reading("a-1", david, "2026-09-24T00:01:00.000Z", [window("five_hour", 0.4, "2026-09-24T00:00:00.000Z")])] },
      // The laptop read later, so its reading is the newest, but its five-hour numbers were observed at the desk's instant.
      {
        environmentId: "laptop",
        readings: [reading("b-7", david, "2026-09-24T00:02:00.000Z", [window("seven_day", 0.1, "2026-09-24T00:02:00.000Z"), window("five_hour", 0.3, "2026-09-24T00:00:00.000Z")])],
      },
    ]);
    // The desk's five-hour window, in the newest reading's order.
    expect(gauge?.windows).toEqual([window("seven_day", 0.1, "2026-09-24T00:02:00.000Z"), window("five_hour", 0.4, "2026-09-24T00:00:00.000Z")]);
    expect(gauge?.readAt).toBe("2026-09-24T00:02:00.000Z");
  });

  it("keeps an account never read apart, and says why a gauge has no windows when no reading has any", () => {
    const gauges = poolUsage([
      { environmentId: "desk", readings: [reading("a-1", null, "2026-09-24T00:01:00.000Z", [], "The account is not signed in.")] },
      {
        environmentId: "laptop",
        readings: [
          reading("b-1", null, "2026-09-24T00:01:00.000Z", [], "The account is not signed in."),
          reading("b-2", david, "2026-09-24T00:01:00.000Z", [], "The provider reports no plan limits."),
        ],
      },
    ]);
    expect(gauges.map((gauge) => [gauge.identity?.email ?? null, gauge.accounts.map((a) => a.accountId), gauge.unavailableReason])).toEqual([
      [null, ["a-1"], "The account is not signed in."],
      [null, ["b-1"], "The account is not signed in."],
      ["david@example.com", ["b-2"], "The provider reports no plan limits."],
    ]);
  });

  it("pools what each enabled environment's request cache holds, and says per environment how its read went", () => {
    const desk = writable<CachedAnswer<"accounts.usage">>({ result: null, fetchedAt: null, error: null, loading: true });
    const laptop = writable<CachedAnswer<"accounts.usage">>({ result: null, fetchedAt: null, error: null, loading: false });
    const view = usageProjection({
      environments: writable(["desk", "laptop"]),
      source: (environmentId) => (environmentId === "desk" ? desk : laptop),
    });
    const seen: unknown[] = [];
    onTestFinished(view.subscribe((value) => seen.push(value)));
    desk.set({ result: { readings: [reading("a-1", david, "2026-09-24T00:01:00.000Z", [window("five_hour", 0.4, "2026-09-24T00:01:00.000Z")])] }, fetchedAt: "2026-09-24T00:01:00.000Z", error: null, loading: false });
    laptop.set({ result: { readings: [reading("b-7", david, "2026-09-24T00:00:30.000Z", [window("five_hour", 0.3, "2026-09-24T00:02:00.000Z")])] }, fetchedAt: "2026-09-24T00:01:00.000Z", error: null, loading: false });
    expect(view.read().gauges).toEqual([expect.objectContaining({ identity: david, windows: [window("five_hour", 0.3, "2026-09-24T00:02:00.000Z")] })]);
    expect(view.read().environments).toEqual([
      { environmentId: "desk", value: [expect.objectContaining({ accountId: "a-1" })], fetchedAt: "2026-09-24T00:01:00.000Z", error: null, loading: false },
      { environmentId: "laptop", value: [expect.objectContaining({ accountId: "b-7" })], fetchedAt: "2026-09-24T00:01:00.000Z", error: null, loading: false },
    ]);
    expect(seen.length).toBeGreaterThan(0);
  });

  it("pools the readings two environments serve on a real runtime, and reads one again on its usage.updated", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }, { name: "laptop" }] });
    const [desk, laptop] = environments as [ScriptedEnvironment, ScriptedEnvironment];
    let laptopFiveHour = window("five_hour", 0.3, "2026-09-24T00:00:30.000Z");
    desk.wire.answer("accounts.usage", () => ({ result: { readings: [reading("a-1", david, "2026-09-24T00:01:00.000Z", [window("five_hour", 0.4, "2026-09-24T00:01:00.000Z")])] } }));
    laptop.wire.answer("accounts.usage", () => ({
      result: {
        readings: [
          reading("b-7", david, "2026-09-24T00:00:30.000Z", [laptopFiveHour]),
          reading("b-8", seth, "2026-09-24T00:00:10.000Z", [window("five_hour", 0.9, "2026-09-24T00:00:10.000Z")]),
        ],
      },
    }));
    onTestFinished(runtime.projections.usage.subscribe(() => undefined));
    await flush();
    const [deskId, laptopId] = [desk.wire.environmentId, laptop.wire.environmentId];
    expect(runtime.projections.usage.read().environments.map(({ environmentId, error }) => [environmentId, error])).toEqual([
      [deskId, null],
      [laptopId, null],
    ]);
    expect(runtime.projections.usage.read().gauges).toEqual([
      {
        identity: david,
        accounts: [
          { environmentId: deskId, accountId: "a-1" },
          { environmentId: laptopId, accountId: "b-7" },
        ],
        windows: [window("five_hour", 0.4, "2026-09-24T00:01:00.000Z")],
        readAt: "2026-09-24T00:01:00.000Z",
        unavailableReason: null,
      },
      { identity: seth, accounts: [{ environmentId: laptopId, accountId: "b-8" }], windows: [window("five_hour", 0.9, "2026-09-24T00:00:10.000Z")], readAt: "2026-09-24T00:00:10.000Z", unavailableReason: null },
    ]);

    // A run on the laptop reports the five-hour window: its usage.updated reads the laptop again, and the gauge takes the later observation.
    laptopFiveHour = window("five_hour", 0.7, "2026-09-24T00:02:00.000Z");
    laptop.notices.event(noticeEvent(1, laptopId, "usage.updated", { accountId: "b-7", identity: david }));
    await flush();
    expect(runtime.projections.usage.read().gauges[0]?.windows).toEqual([laptopFiveHour]);
  });
});

describe("the mode picker", () => {
  it("offers the contracts' modes in their order, each allowed up to the connection's ceiling", async () => {
    const { runtime, environments } = await scriptedEnvironments({ onCleanup: onTestFinished, environments: [{ name: "desk" }] });
    const env = (environments[0] as ScriptedEnvironment).wire.environmentId;
    expect(runtime.projections.modes(env).read()).toEqual({
      environmentId: env,
      ceiling: "bypassPermissions",
      modes: MODES.map((mode) => ({ mode, allowed: true })),
    });
    expect(modePicker("env", "acceptEdits")).toEqual({
      environmentId: "env",
      ceiling: "acceptEdits",
      modes: [
        { mode: "plan", allowed: true },
        { mode: "acceptEdits", allowed: true },
        { mode: "auto", allowed: false },
        { mode: "bypassPermissions", allowed: false },
      ],
    });
    // Before the environment has said, no mode is known to be allowed.
    expect(modePicker("env", null).modes.every((choice) => !choice.allowed)).toBe(true);
  });
});
