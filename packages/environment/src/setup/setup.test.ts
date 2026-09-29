import { randomUUID } from "node:crypto";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { registry, type ParamsOf, type ResponseOf, type StepResult } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { bubblewrapProbe, brokenProbe } from "../../test/containment.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `setup.check` through the primary seam (ADR 0031; permissions spec, "The
 * Permissions step"; #141): an in-process environment on a scripted
 * containment probe, driven by a real client over a real WebSocket. What is
 * asserted is what a client sees: each step's state, its line, the checks
 * that failed and the actions offered.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

type Command = "permissions.settings.set" | "permissions.denylist.set" | "permissions.denylist.restorePresets";

/** Sends a command with a fresh command id; resolves with its response, checked against its schema. */
const send = async <N extends Command>(client: WireClient, method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<ResponseOf<N>> =>
  registry[method].response.parse(await client.request(method, { commandId: randomUUID(), ...params } as ParamsOf<N>)) as ResponseOf<N>;

/** The one result `setup.check` answers for `step`. */
const check = async (client: WireClient, step: StepResult["step"]): Promise<StepResult> => {
  const { results } = await client.request("setup.check", { step });
  expect(results.map((result) => result.step)).toEqual([step]);
  return results[0] as StepResult;
};

describe("setup.check", () => {
  it("checks every registered step on a fresh environment, in the milestone-1 order: each done but Your machines, whose release channel is not read yet, with its line and the environment's clock", async () => {
    const t = await start();
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    expect(results.map((result) => [result.step, result.state, result.failing, result.actions])).toEqual([
      ["account", "done", [], []],
      ["your-machines", "needs-attention", ["your-machines.release-channel"], ["check-again"]],
      ["permissions", "done", [], []],
      ["appearance", "done", [], []],
    ]);
    for (const result of results) expect(result.checkedAt, result.step).toBe(MANUAL_CLOCK_START);
    const permissions = results.find((result) => result.step === "permissions");
    expect(permissions?.reason).toBe(
      "The containment default can be enforced here. Each denylist section holds its presets, or was emptied on purpose. The environment runs as a non-root user.",
    );
  });

  it("checks one step when asked for it, at the time it runs", async () => {
    const t = await start();
    const client = await t.client();
    t.clock.advance(90_000);
    const result = await check(client, "appearance");
    expect(result).toMatchObject({ state: "done", checkedAt: new Date(Date.parse(MANUAL_CLOCK_START) + 90_000).toISOString() });
  });

  it("needs read, and refuses a step that is not registered", async () => {
    const t = await start();
    const reader = await t.client({ token: (await t.pair({ scopes: ["read"] })).token });
    expect((await reader.request("setup.check", { step: "permissions" })).results).toHaveLength(1);
    const driver = await t.client({ token: (await t.pair({ scopes: ["runs:drive"] })).token });
    expect(await refusal(driver.request("setup.check", {}))).toMatchObject({ code: "forbidden", data: { scope: "read" } });
    expect(await refusal(reader.request("setup.check", { step: "forges" } as never))).toMatchObject({ code: "invalid_params" });
  });
});

describe("the Your machines step's health line", () => {
  it("reports not-root from what permissions.settings.get answers as isRoot", async () => {
    const t = await start();
    const client = await t.client();
    expect((await client.request("permissions.settings.get", {})).isRoot).toBe(false);
    // With auto-update off, the release channel's check holds without a check (#346).
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.autoUpdate": false } });
    expect(await check(client, "your-machines")).toMatchObject({
      state: "done",
      reason: "The environment runs as a non-root user. Auto-update is off, or the release channel was read in the last 24 hours. Auto-update is on or the channel's newest runs, no update is past its cap or blocked, and no failed update left this machine behind. Outside a container, or the host-side updater polled in the last hour.",
      failing: [],
    });
  });
});

describe("the Permissions step's check", () => {
  it("is done on a fresh environment whose probe finds no mechanism: the preset default is off there, which is enforceable", async () => {
    const t = await start();
    const client = await t.client();
    expect((await client.request("permissions.settings.get", {})).values["permissions.containment.default"]).toBe("off");
    expect((await check(client, "permissions")).state).toBe("done");
  });

  it("needs attention when the default is workspace and the probe finds no mechanism, naming containment with the Linux package hint", async () => {
    const dataDir = `${tempDir()}/data`;
    const first = await startTestEnvironment({ dataDir, containment: bubblewrapProbe() });
    const admin = await first.client();
    expect((await send(admin, "permissions.settings.set", { values: { "permissions.containment.default": "workspace" } })).receipt).toMatchObject({ status: "accepted" });
    expect((await check(admin, "permissions")).state).toBe("done");
    await first.close();

    // The same environment started again on a machine where bubblewrap is gone: the stored default no longer holds.
    const second = await start({ dataDir });
    const client = await second.client();
    const result = await check(client, "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.containment"], actions: [] });
    expect(result.reason).toContain("The containment default workspace cannot be enforced here: ");
    expect(result.reason).toContain("bubblewrap is not installed");
    expect(result.reason).toContain("install the bubblewrap and socat packages (sudo apt-get install bubblewrap socat)");
    expect(result.reason).toContain("on Ubuntu 24.04 and later");
    expect(result.reason).toContain("/etc/apparmor.d/bwrap");
    expect(result.reason).not.toMatch(/\n/);
    // The Your machines step's not-root line is not what fails.
    expect((await check(client, "your-machines")).failing).not.toContain("your-machines.not-root");
  });

  it("names the container's seccomp profile beside the package hint when that is what refused bubblewrap", async () => {
    const dataDir = `${tempDir()}/data`;
    const first = await startTestEnvironment({ dataDir, containment: bubblewrapProbe() });
    await send(await first.client(), "permissions.settings.set", { values: { "permissions.containment.default": "workspace-no-network" } });
    await first.close();
    const second = await start({ dataDir, containment: brokenProbe() });
    const result = await check(await second.client(), "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.containment"] });
    expect(result.reason).toContain("The containment default workspace-no-network cannot be enforced here: ");
    expect(result.reason).toContain("bubblewrap and socat");
    expect(result.reason).toContain("a seccomp profile that allows unshare(CLONE_NEWUSER)");
  });

  it("needs attention when a section is missing presets, naming them, with Restore; restoring the presets makes it done", async () => {
    const t = await start();
    const admin = await t.client();
    const { denylist } = await admin.request("permissions.denylist.get", {});
    const paths = denylist.paths.filter((entry) => entry.pattern !== "~/.aws" && entry.pattern !== "~/.kube");
    await send(admin, "permissions.denylist.set", { sections: { paths } });
    const result = await check(admin, "permissions");
    expect(result).toMatchObject({ state: "needs-attention", failing: ["permissions.denylist"], actions: ["restore"] });
    expect(result.reason).toBe("The paths section of the denylist is missing 2 of its presets (~/.aws, ~/.kube); Restore puts them back.");

    await send(admin, "permissions.denylist.restorePresets", {});
    expect((await check(admin, "permissions")).state).toBe("done");
  });

  it("stays done when a person empties a section on purpose, or disables and edits presets, which the section still holds", async () => {
    const t = await start();
    const admin = await t.client();
    const { denylist } = await admin.request("permissions.denylist.get", {});
    await send(admin, "permissions.denylist.set", {
      sections: {
        browserDomains: [],
        commandPatterns: denylist.commandPatterns.map((entry) => ({ ...entry, enabled: false })),
        paths: denylist.paths.map((entry) => (entry.pattern === "~/.aws" ? { ...entry, pattern: "~/.aws/credentials" } : entry)),
      },
    });
    expect((await admin.request("permissions.denylist.get", {})).denylist.browserDomains).toEqual([]);
    expect(await check(admin, "permissions")).toMatchObject({ state: "done", failing: [] });
  });

  it("is never skipped: every result is done or needs attention", async () => {
    const t = await start();
    const client = await t.client();
    const { results } = await client.request("setup.check", {});
    expect(results.every((result) => result.state !== "skipped")).toBe(true);
  });
});
