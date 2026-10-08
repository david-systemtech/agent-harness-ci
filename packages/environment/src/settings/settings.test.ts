import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Ceiling, DEFAULT_THEME, presetPermissionSettings, presetSettings, type EventFrame, type Scope } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startTestEnvironment, type TestEnvironment } from "../../test/helper.js";
import { create, listStream, refusal } from "../../test/sessions.js";
import { eventsAfter, updateSettings } from "../../test/shelf.js";

/**
 * The generic settings methods through the primary seam (session-state
 * spec, "Commands"): `settings.get` answers every key or those asked, a key
 * never set at its preset; `settings.update` checks each value against its
 * key's schema and records what changed as one `settings.updated` on the
 * environment's settings stream, with its receipt.
 */

const { onCleanup, tempDir } = useCleanups();

const start = async (dataDir?: string): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(dataDir === undefined ? {} : { dataDir });
  onCleanup(() => t.close());
  return t;
};

const presets = presetSettings();

/** A client session issued straight from the environment, holding only `scopes`. */
const scopedClient = (t: TestEnvironment, scopes: Scope[]) =>
  t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a scoped program", scopes, ceiling: Ceiling.parse("acceptEdits") }).token });

describe("settings.get", () => {
  it("preserves saved browser host lists with earlier numeric entries through rebuild and restart", async () => {
    const dataDir = tempDir();
    const first = await start(dataDir);
    const values = { "browser.devSites": ["1.2.3.4.5", "dev.example"], "browser.internalHosts": ["08", "private.example"] };
    first.env.log.append({ kind: "settings", id: first.env.id }, [{ type: "settings.updated", payload: { values } }], { actor: "system:settings" });
    const client = await first.client();
    expect(await client.request("settings.get", { keys: ["browser.devSites", "browser.internalHosts"] })).toEqual({ values });
    await client.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(await client.request("settings.get", { keys: ["browser.devSites", "browser.internalHosts"] })).toEqual({ values });
    await first.close();
    const second = await start(dataDir);
    expect(await (await second.client()).request("settings.get", { keys: ["browser.devSites", "browser.internalHosts"] })).toEqual({ values });
  });

  it("answers every key at its preset on an environment nobody has changed: 14 days idle, no settle on merge, compaction after 90 days, no default account, family or effort, the update keys' presets (#335), the Default theme (#391), the browser keys' (#541), injection allowed with no account's entry (#367), the tailnet bound with no LAN address (#574), and the orientation block on (#505)", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("settings.get", {})).toEqual({
      values: {
        "sessions.autoSettleAfterIdle": { amount: 14, unit: "days" },
        "sessions.autoSettleOnMerge": false,
        "sessions.transcriptCompactAfterDays": 90,
        "accounts.defaultAccount": null,
        "accounts.defaultModelFamily": null,
        "accounts.defaultEffort": null,
        "accounts.favouriteModels": [],
        "providers.processIdleMinutes": 30,
        ...presetPermissionSettings(),
        "updates.autoUpdate": true,
        "updates.channel": "stable",
        "updates.pinnedVersion": null,
        "updates.idleWindowMinutes": 10,
        "updates.deferralCapHours": 24,
        "appearance.theme": DEFAULT_THEME,
        "browser.devSites": [],
        "browser.evaluateEverywhere": false,
        "browser.deepReadEverywhere": false,
        "browser.reach": {},
        "browser.headless.allowRuns": true,
        "browser.headless.endpoint": null,
        "browser.headless.executable": null,
        "browser.headless.limits": { maxContexts: 2, idleMinutes: 10, tabHeapMb: 500, exitMinutes: 5 },
        "browser.internalHosts": ["localhost", "127.0.0.1", "::1"],
        "credentials.injection": "allow",
        "credentials.injectionByAccount": {},
        "network.bindTailnet": true,
        "network.bindLan": null,
        "instructions.orientation": true,
      },
    });
  });

  it("answers only the keys asked for, and none for none", async () => {
    const t = await start();
    const client = await t.client();
    expect(await client.request("settings.get", { keys: ["sessions.autoSettleOnMerge"] })).toEqual({ values: { "sessions.autoSettleOnMerge": false } });
    expect(await client.request("settings.get", { keys: [] })).toEqual({ values: {} });
  });

  it("refuses a key that is not a setting invalid_params", async () => {
    const t = await start();
    const client = await t.client();
    expect(await refusal(client.request("settings.get", { keys: ["theme" as never] }))).toMatchObject({
      code: "invalid_params",
      data: { issues: [expect.objectContaining({ path: ["keys", 0] })] },
    });
  });
});

describe("settings.update", () => {
  it("records what changed as one settings.updated on the environment's settings stream, with the command's id and actor, and answers every value", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const commandId = randomUUID();

    const answer = await updateSettings(client, { "sessions.autoSettleAfterIdle": { amount: 2, unit: "weeks" }, "sessions.autoSettleOnMerge": false }, commandId);

    const values = { ...presets, "sessions.autoSettleAfterIdle": { amount: 2, unit: "weeks" } };
    // The head after the notice settings.changed, appended beside it on the environment's own stream (#391).
    expect(answer).toEqual({ receipt: { status: "accepted", sequence: head + 2, changed: true }, result: { values } });
    expect(eventsAfter(t, head)).toEqual([
      expect.objectContaining({
        streamKind: "settings",
        streamId: t.env.id,
        type: "settings.updated",
        commandId,
        occurredAt: MANUAL_CLOCK_START,
        actor: `client_session:${client.hello.clientSessionId}`,
        payload: { values: { "sessions.autoSettleAfterIdle": { amount: 2, unit: "weeks" } } },
      }),
    ]);
    expect(await client.request("settings.get", {})).toEqual({ values });
  });

  it("changes nothing when every value is the one held, a preset never set included: accepted, changed false, no event", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    // The generic keys at their presets; the permission keys are permissions.settings.set's to write (#129).
    const generic = { "sessions.autoSettleAfterIdle": presets["sessions.autoSettleAfterIdle"], "sessions.autoSettleOnMerge": presets["sessions.autoSettleOnMerge"] };
    for (const values of [{}, generic, { "sessions.autoSettleOnMerge": false }]) {
      expect(await updateSettings(client, values)).toEqual({ receipt: { status: "accepted", sequence: head, changed: false }, result: { values: presets } });
    }
    await updateSettings(client, { "sessions.autoSettleAfterIdle": null });
    const after = t.env.log.head();
    expect((await updateSettings(client, { "sessions.autoSettleAfterIdle": null })).receipt).toEqual({ status: "accepted", sequence: after, changed: false });
    expect(await client.request("settings.get", { keys: ["sessions.autoSettleAfterIdle"] })).toEqual({ values: { "sessions.autoSettleAfterIdle": null } });
  });

  it("changes nothing when a held object value is sent with its fields in another order", async () => {
    const t = await start();
    const client = await t.client();
    await updateSettings(client, { "sessions.autoSettleAfterIdle": { amount: 3, unit: "weeks" } });
    const head = t.env.log.head();
    const answer = await updateSettings(client, { "sessions.autoSettleAfterIdle": { unit: "weeks", amount: 3 } });
    expect(answer.receipt).toEqual({ status: "accepted", sequence: head, changed: false });
    expect(t.env.log.head()).toBe(head);
  });

  it("answers a retry of the same command its first receipt, applying it once", async () => {
    const t = await start();
    const client = await t.client();
    const commandId = randomUUID();
    const first = await updateSettings(client, { "sessions.autoSettleOnMerge": true }, commandId);
    const head = t.env.log.head();
    expect(await updateSettings(client, { "sessions.autoSettleOnMerge": true }, commandId)).toEqual({ receipt: first.receipt });
    expect(t.env.log.head()).toBe(head);
  });

  it("refuses a value its key's schema does not take, or a key that is not a setting, invalid_params naming the key, and appends nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ "sessions.autoSettleOnMerge": "yes" }, { path: ["values", "sessions.autoSettleOnMerge"] }],
      [{ "sessions.autoSettleOnMerge": null }, { path: ["values", "sessions.autoSettleOnMerge"] }],
      [{ "sessions.autoSettleAfterIdle": { amount: 0, unit: "days" } }, { path: ["values", "sessions.autoSettleAfterIdle", "amount"] }],
      [{ "sessions.autoSettleAfterIdle": { amount: 2, unit: "fortnights" } }, { path: ["values", "sessions.autoSettleAfterIdle", "unit"] }],
      [{ "sessions.autoSettleAfterIdle": 14 }, { path: ["values", "sessions.autoSettleAfterIdle"] }],
      [{ theme: "invalid-theme" }, { path: ["values"], keys: ["theme"] }],
    ];
    for (const [values, issue] of cases) {
      expect(await refusal(client.request("settings.update", { commandId: randomUUID(), values } as never)), JSON.stringify(values)).toMatchObject({
        code: "invalid_params",
        data: { issues: [expect.objectContaining(issue)] },
      });
    }
    expect(t.env.log.head()).toBe(head);
    expect(await client.request("settings.get", {})).toEqual({ values: presets });
  });

  it("needs admin to update and read to get", async () => {
    const t = await start();
    const reader = await scopedClient(t, ["read", "sessions:write"]);
    expect(await refusal(updateSettings(reader, { "sessions.autoSettleOnMerge": true }))).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    expect(await reader.request("settings.get", {})).toEqual({ values: presets });
    const admin = await scopedClient(t, ["admin"]);
    expect(await refusal(admin.request("settings.get", {}))).toMatchObject({ code: "forbidden", data: { scope: "read" } });
    expect((await updateSettings(admin, { "sessions.autoSettleOnMerge": true })).receipt).toMatchObject({ changed: true });
  });

  it("is not on the session list: a settings change reaches no list subscriber", async () => {
    const t = await start();
    const client = await t.client();
    const list = await listStream(client, t.env.log.head());
    await updateSettings(client, { "sessions.autoSettleOnMerge": true });
    const { id } = await create(client);
    expect((await list.next()).streamId).toBe(id);
  });

  it("keeps what was set across a restart on the same data directory, and through a rebuild of the projections", async () => {
    const dataDir = join(tempDir(), "data");
    const first = await start(dataDir);
    const client = await first.client();
    const values = { "sessions.autoSettleAfterIdle": { amount: 3, unit: "months" }, "sessions.autoSettleOnMerge": true, "providers.processIdleMinutes": 45 } as const;
    await updateSettings(client, values);
    await first.close();

    const second = await start(dataDir);
    const again = await second.client();
    expect(await again.request("settings.get", {})).toEqual({ values: { ...presets, ...values } });
    const rebuilt = await again.request("environment.rebuildProjections", { commandId: randomUUID() });
    expect(rebuilt.result?.projectors).toEqual(expect.arrayContaining(["session-list", "settings"]));
    expect(await again.request("settings.get", {})).toEqual({ values: { ...presets, ...values } });
  });
});

describe("settings.changed (GUI spec, \"Live\"; #391)", () => {
  const ember = { name: "Ember", seeds: { ...DEFAULT_THEME.seeds, accent: { hue: 55, chroma: 0.19 } } };

  /** Every event of the settings and environment streams after `sequence`, as its stream, type, payload, command and actor. */
  const writtenAfter = (t: TestEnvironment, sequence: number) =>
    t.env.log
      .readStream({ kinds: ["settings", "environment"] }, sequence)
      .map((event) => ({ streamKind: event.streamKind, streamId: event.streamId, type: event.type, payload: event.payload, commandId: event.commandId, actor: event.actor }));

  it("is appended on the environment's own stream in the transaction of every settings.updated, whichever method wrote it, naming the keys that changed", async () => {
    const t = await start();
    const client = await t.client();
    const actor = `client_session:${client.hello.clientSessionId}`;
    const writes = [
      { method: "settings.update", values: { "sessions.autoSettleOnMerge": true, "appearance.theme": ember } },
      { method: "permissions.settings.set", values: { "permissions.defaultCeiling": "auto", "permissions.unattended.mode": "acceptEdits" } },
      { method: "updates.settings.set", values: { "updates.idleWindowMinutes": 20 } },
    ] as const;
    const changed = [["sessions.autoSettleOnMerge", "appearance.theme"], ["permissions.defaultCeiling"], ["updates.idleWindowMinutes"]];
    for (const [i, { method, values }] of writes.entries()) {
      const head = t.env.log.head();
      const commandId = randomUUID();
      const { receipt } = (await client.request(method, { commandId, values } as never)) as { receipt: { status: string; sequence: number; changed: boolean } };
      const keys = changed[i] as string[];
      expect(writtenAfter(t, head), method).toEqual([
        {
          streamKind: "settings",
          streamId: t.env.id,
          type: "settings.updated",
          payload: { values: Object.fromEntries(keys.map((key) => [key, (values as Record<string, unknown>)[key]])) },
          commandId,
          actor,
        },
        { streamKind: "environment", streamId: t.env.id, type: "settings.changed", payload: { keys }, commandId, actor },
      ]);
      // One transaction, the notice straight after the change: the receipt, written with both, names the notice as the head.
      const [updated, notice] = t.env.log.readStream({ kinds: ["settings", "environment"] }, head);
      expect(notice?.sequence, method).toBe((updated?.sequence ?? 0) + 1);
      expect(receipt, method).toEqual({ status: "accepted", sequence: notice?.sequence, changed: true });
    }
  });

  it("is not appended by a write that changes nothing", async () => {
    const t = await start();
    const client = await t.client();
    const head = t.env.log.head();
    await updateSettings(client, { "appearance.theme": DEFAULT_THEME, "sessions.autoSettleOnMerge": false });
    await client.request("permissions.settings.set", { commandId: randomUUID(), values: { "permissions.defaultCeiling": "acceptEdits" } });
    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.channel": "stable" } });
    expect(writtenAfter(t, head)).toEqual([]);
  });

  it("reaches a client subscribed to environment.subscribe, as every notice does", async () => {
    const t = await start();
    const writer = await t.client();
    const watcher = await t.client();
    const { subscription } = await watcher.subscribe("environment.subscribe", { afterSequence: t.env.log.head() });
    await watcher.next((frame) => frame.type === "synchronized" && "subscription" in frame && frame.subscription === subscription);
    await updateSettings(writer, { "appearance.theme": ember });
    const frame = await watcher.next((f): f is EventFrame => f.type === "event" && f.subscription === subscription);
    expect(frame.event).toMatchObject({ streamKind: "environment", type: "settings.changed", payload: { keys: ["appearance.theme"] } });
  });
});
