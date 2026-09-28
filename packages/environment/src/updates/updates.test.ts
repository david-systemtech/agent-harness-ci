import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DISCOVERY_PATH, HEALTH_PATH, PROTOCOL_VERSION, presetSettings, type Frame, type UpdateSettingsPatch } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { TEST_CLAUDE_CODE_VERSION, startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { testLauncher } from "../../test/launcher.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import type { Address } from "../serve/http.js";
import { HARNESS_VERSION } from "../serve/start.js";

/**
 * The update settings, `updates.status`, the idle window and the
 * `self-update` flag through the primary seam (launcher-update spec,
 * "Settings, methods, notices and flags"): the in-process environment under
 * the scripted launcher channel and the manual clock, driven over the wire.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

const getJson = async (address: Address, path: string): Promise<Record<string, unknown>> =>
  (await (await fetch(`http://${address.host}:${address.port}${path}`)).json()) as Record<string, unknown>;

/** Sets update settings through the one method that writes them. */
const setUpdates = (client: WireClient, values: UpdateSettingsPatch, commandId = randomUUID()) => client.request("updates.settings.set", { commandId, values });

/** The update settings' presets, all five. */
const UPDATE_PRESETS = {
  "updates.autoUpdate": true,
  "updates.channel": "stable",
  "updates.pinnedVersion": null,
  "updates.idleWindowMinutes": 10,
  "updates.deferralCapHours": 24,
} as const;

/** The `environment.started` notices on the environment's stream, oldest first. */
const startsNoted = async (t: TestEnvironment): Promise<unknown[]> => {
  const client = await t.client();
  const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
  const mine = (frame: Frame) => "subscription" in frame && frame.subscription === subscription;
  await client.next((frame) => frame.type === "synchronized" && mine(frame));
  const started = client.received.flatMap((frame) => (frame.type === "event" && mine(frame) && frame.event.type === "environment.started" ? [frame.event.payload] : []));
  await client.close();
  return started;
};

describe("the harness version", () => {
  it("is an option of the environment: one data directory started as two versions reports each on discovery, health, prepared and its start", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir, harnessVersion: "0.4.1", launcher: testLauncher({ present: true }) });
    expect(await getJson(first.address, DISCOVERY_PATH)).toMatchObject({ harnessVersion: "0.4.1" });
    expect(await getJson(first.address, HEALTH_PATH)).toEqual({ status: "ready", version: "0.4.1" });
    expect(first.launcher.received[0]).toEqual({ type: "prepared", version: "0.4.1" });
    await first.close();

    const second = await start({ dataDir, harnessVersion: "0.5.0-beta.1" });
    expect(await getJson(second.address, DISCOVERY_PATH)).toMatchObject({ harnessVersion: "0.5.0-beta.1" });
    expect(await getJson(second.address, HEALTH_PATH)).toEqual({ status: "ready", version: "0.5.0-beta.1" });
    expect(await startsNoted(second)).toEqual([
      { harnessVersion: "0.4.1", protocolVersion: PROTOCOL_VERSION },
      { harnessVersion: "0.5.0-beta.1", protocolVersion: PROTOCOL_VERSION },
    ]);
  });
});

describe("updates.status", () => {
  it("answers what runs here: the running version, the protocol version and the bundled Claude Code version", async () => {
    const t = await start({ harnessVersion: "0.4.1" });
    const client = await t.client();
    expect(await client.request("updates.status", {})).toMatchObject({ version: "0.4.1", protocolVersion: PROTOCOL_VERSION, bundledClaudeCodeVersion: TEST_CLAUDE_CODE_VERSION });
  });

  it("answers the bundled Claude Code version as null when it cannot be read, and reads it once", async () => {
    let reads = 0;
    const t = await start({
      claudeCodeVersion: async () => {
        reads += 1;
        return null;
      },
    });
    const client = await t.client();
    expect(await client.request("updates.status", {})).toMatchObject({ bundledClaudeCodeVersion: null });
    expect(await client.request("updates.status", {})).toMatchObject({ bundledClaudeCodeVersion: null });
    expect(reads).toBe(1);
  });

  it("under a foreground serve, names no manager and says why, with nothing installed and the channel, pending and outcome parts empty", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("updates.status", {})).toEqual({
      version: HARNESS_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      bundledClaudeCodeVersion: TEST_CLAUDE_CODE_VERSION,
      manager: { kind: "none", reason: expect.stringMatching(/foreground/) as unknown as string },
      newest: null,
      lastCheck: null,
      pending: { state: "current" },
      lastOutcome: null,
      failedVersions: [],
      installed: [],
    });
  });

  it("under a launcher, names it with its version, and lists the versions installed as its versions? answers them", async () => {
    const launcher = testLauncher({
      present: true,
      versions: () => ({ type: "versions", installed: ["0.4.0", "0.4.1", "0.5.0-beta.1"], launcherVersion: "0.4.0", launcherProtocol: 1 }),
    });
    const t = await start({ harnessVersion: "0.4.1", launcher });
    const client = await t.client();
    expect(await client.request("updates.status", {})).toMatchObject({
      version: "0.4.1",
      manager: { kind: "launcher", launcherVersion: "0.4.0" },
      installed: ["0.4.0", "0.4.1", "0.5.0-beta.1"],
    });
    expect(launcher.received.filter((message) => message.type === "versions?")).toHaveLength(1);
  });

  it("under a launcher that no longer answers, names no manager and says why", async () => {
    const launcher = testLauncher({ present: true });
    const t = await start({ launcher });
    const client = await t.client();
    launcher.leave();
    expect(await client.request("updates.status", {})).toMatchObject({ manager: { kind: "none", reason: expect.stringMatching(/launcher/) as unknown as string }, installed: [] });
  });

  it("in a container with no launcher, says its updates are managed outside, with no host-side updater's poll yet", async () => {
    const t = await start({ containerDetector: { inContainer: () => true } });
    const client = await t.client();
    expect(await client.request("updates.status", {})).toMatchObject({ manager: { kind: "outside", lastPoll: null }, installed: [] });
  });

  it("in a container under a launcher, names the launcher", async () => {
    const t = await start({ containerDetector: { inContainer: () => true }, launcher: testLauncher({ present: true }) });
    const client = await t.client();
    expect(await client.request("updates.status", {})).toMatchObject({ manager: { kind: "launcher", launcherVersion: HARNESS_VERSION }, installed: [HARNESS_VERSION] });
  });

  it("answers a read-only client session", async () => {
    const t = await start();
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read"], ceiling: "plan" }).token });
    expect(await reader.request("updates.status", {})).toMatchObject({ version: HARNESS_VERSION });
  });
});

describe("updates.settings.set", () => {
  it("records the keys it changes as one settings.updated on the settings stream, with the command's id and actor, and answers all five", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const commandId = randomUUID();

    const answer = await setUpdates(client, { "updates.channel": "beta", "updates.idleWindowMinutes": 25, "updates.autoUpdate": true }, commandId);

    const values = { ...UPDATE_PRESETS, "updates.channel": "beta", "updates.idleWindowMinutes": 25 };
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: head + 1, changed: true }, result: { values } });
    expect(t.env.log.readStream({ kinds: ["settings"] }, head)).toEqual([
      expect.objectContaining({
        streamKind: "settings",
        streamId: t.env.id,
        type: "settings.updated",
        commandId,
        occurredAt: MANUAL_CLOCK_START,
        actor: `client_session:${client.hello.clientSessionId}`,
        payload: { values: { "updates.channel": "beta", "updates.idleWindowMinutes": 25 } },
      }),
    ]);
    expect(t.env.log.head()).toBe(head + 1);
    expect(await client.request("settings.get", {})).toEqual({ values: { ...presetSettings(), ...values } });
  });

  it("sets a pin and clears it, and keeps each key across a restart on the same data directory", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await startTestEnvironment({ dataDir });
    const client = await first.client();
    await setUpdates(client, { "updates.pinnedVersion": "0.4.2", "updates.autoUpdate": false, "updates.deferralCapHours": 168 });
    expect((await setUpdates(client, { "updates.pinnedVersion": null })).result?.values).toMatchObject({ "updates.pinnedVersion": null, "updates.autoUpdate": false });
    await setUpdates(client, { "updates.pinnedVersion": "1.0.0-rc.1" });
    await first.close();

    const second = await start({ dataDir });
    const again = await second.client();
    expect((await setUpdates(again, {})).result?.values).toEqual({
      ...UPDATE_PRESETS,
      "updates.pinnedVersion": "1.0.0-rc.1",
      "updates.autoUpdate": false,
      "updates.deferralCapHours": 168,
    });
  });

  it("changes nothing when every value is the one held, a preset never set included: accepted, changed false, no event", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const values of [{}, UPDATE_PRESETS, { "updates.channel": "stable" }] as const) {
      expect(await setUpdates(client, values)).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { values: UPDATE_PRESETS } });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses a value outside its key's schema or range, or a key that is not an update setting, invalid_params naming the key, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ "updates.idleWindowMinutes": 0 }, { path: ["values", "updates.idleWindowMinutes"] }],
      [{ "updates.idleWindowMinutes": 121 }, { path: ["values", "updates.idleWindowMinutes"] }],
      [{ "updates.idleWindowMinutes": 2.5 }, { path: ["values", "updates.idleWindowMinutes"] }],
      [{ "updates.deferralCapHours": 0 }, { path: ["values", "updates.deferralCapHours"] }],
      [{ "updates.deferralCapHours": 169 }, { path: ["values", "updates.deferralCapHours"] }],
      [{ "updates.channel": "nightly" }, { path: ["values", "updates.channel"] }],
      [{ "updates.pinnedVersion": "v0.4.2" }, { path: ["values", "updates.pinnedVersion"] }],
      [{ "updates.autoUpdate": "on" }, { path: ["values", "updates.autoUpdate"] }],
      [{ "sessions.autoSettleOnMerge": true }, { path: ["values"], keys: ["sessions.autoSettleOnMerge"] }],
    ];
    for (const [values, issue] of cases) {
      expect(await refusal(client.request("updates.settings.set", { commandId: randomUUID(), values } as never)), JSON.stringify(values)).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining(issue)] },
      });
    }
    expect(t.env.log.head()).toBe(head);
  });

  it("needs admin", async () => {
    const t = await start();
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read", "sessions:write"], ceiling: "plan" }).token });
    expect(await refusal(setUpdates(reader, { "updates.channel": "beta" }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
  });
});

describe("settings.update", () => {
  it("refuses every update key, naming updates.settings.set, and changes nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    for (const key of Object.keys(UPDATE_PRESETS)) {
      const refused = await refusal(client.request("settings.update", { commandId: randomUUID(), values: { [key]: UPDATE_PRESETS[key as keyof typeof UPDATE_PRESETS] } } as never));
      expect(refused, key).toMatchObject({ code: "invalid_params", data: { issues: [expect.objectContaining({ path: ["values"], keys: [key] })] } });
      expect(JSON.stringify(refused.data), key).toContain("updates.settings.set");
    }
    expect(t.env.log.head()).toBe(head);
  });
});
