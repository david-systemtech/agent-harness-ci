import type { AuthStatus, StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import type { AccountRef } from "../adapter/contract.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { fakeAdapter, signedInAs } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * The Account step's check (ADR 0018; setup spec, "1. Account"; #574)
 * through the primary seam: an in-process environment whose fake adapter
 * scripts each account's status, and a real client over a real WebSocket.
 * What is asserted is what `setup.check` answers a client: the step's state,
 * its line, the checks that failed, the actions offered and the accounts
 * Sign in again applies to.
 */

const { onCleanup } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** The step's line when every check holds: one sentence of what was found, never its checks' conditions (#1698). */
const ALL_HOLD = "Every account is signed in.";

/** An environment holding `ids` as configured accounts, each answering its status as `status` scripts it; with its client. */
const withAccounts = async (ids: readonly string[], status: (account: AccountRef) => AuthStatus) => {
  const adapter = fakeAdapter({ status });
  const t = await start({ adapter, accounts: ids.map((id) => ({ id, provider: adapter.descriptor.provider })) });
  return { t, client: await t.client() };
};

/** The one result `setup.check` answers for the Account step. */
const checkAccount = async (client: WireClient): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step: "account" });
  expect(results.map((result) => result.step)).toEqual(["account"]);
  return results[0] as StepResult;
};

describe("the Account step with no account", () => {
  it("needs attention saying none is added, with no action, since the card's Sign in is the fix; account.signed-in holds with none to name", async () => {
    const t = await start({ accounts: [] });
    expect(await checkAccount(await t.client())).toEqual({
      step: "account",
      state: "needs-attention",
      reason: "No account is added on this environment: Sign in adds one.",
      failing: ["account.present"],
      actions: [],
      checkedAt: MANUAL_CLOCK_START,
    });
  });
});

describe("the Account step with accounts", () => {
  it("is done with one account signed in", async () => {
    const { client } = await withAccounts(["claude-max"], (account) => signedInAs(`${account.id}@example.com`));
    expect(await checkAccount(client)).toEqual({ step: "account", state: "done", reason: ALL_HOLD, failing: [], actions: [], checkedAt: MANUAL_CLOCK_START });
  });

  it("names one expired account with Sign in again targeting it", async () => {
    const { client } = await withAccounts(["claude-max"], () => ({ ...signedInAs(null), expired: true }));
    expect(await checkAccount(client)).toEqual({
      step: "account",
      state: "needs-attention",
      reason: "The sign-in of claude-max has expired: Sign in again.",
      failing: ["account.signed-in"],
      actions: ["sign-in-again"],
      targets: [{ action: "sign-in-again", kind: "account", id: "claude-max", label: "claude-max" }],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("names each account signed out, expired or unreadable, in the store's order, and not one signed in", async () => {
    const statuses: Record<string, AuthStatus> = {
      personal: signedInAs("personal@example.com"),
      work: signedInAs(null),
      lab: { ...signedInAs(null), expired: true },
      spare: { ...signedInAs(null), error: "The binary could not be run." },
    };
    const { client } = await withAccounts(Object.keys(statuses), (account) => statuses[account.id] ?? signedInAs(null));
    const target = (id: string) => ({ action: "sign-in-again", kind: "account", id, label: id });
    expect(await checkAccount(client)).toEqual({
      step: "account",
      state: "needs-attention",
      reason:
        "work is signed out: Sign in again. The sign-in of lab has expired: Sign in again. The status of spare could not be read (The binary could not be run): Sign in again.",
      failing: ["account.signed-in"],
      actions: ["sign-in-again"],
      targets: [target("work"), target("lab"), target("spare")],
      checkedAt: MANUAL_CLOCK_START,
    });
  });

  it("answers from the statuses the account store holds, reading no account's status for the check, and follows the store's next read", async () => {
    const { t, client } = await withAccounts(["claude-max"], (account) => signedInAs(`${account.id}@example.com`));
    const reads = t.adapter.statusReads.length;
    expect((await checkAccount(client)).state).toBe("done");
    t.adapter.setStatus(() => ({ ...signedInAs(null), expired: true }));
    expect((await checkAccount(client)).state).toBe("done");
    expect(t.adapter.statusReads).toHaveLength(reads);

    await client.request("accounts.refresh", { accountId: "claude-max" });
    expect(await checkAccount(client)).toMatchObject({ state: "needs-attention", failing: ["account.signed-in"], reason: "The sign-in of claude-max has expired: Sign in again." });
  });
});
