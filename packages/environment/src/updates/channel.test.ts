import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StepResult, type EventFrame, type Frame, type UpdateSettingsPatch, type UpdatesStatus } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { OTHER_TOKEN, pasted } from "../../test/forge.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { DATABASE_SCHEMA_VERSION, startFakeReleaseSource, type FakeReleaseSource } from "../../test/release-source.js";
import { refusal } from "../../test/sessions.js";
import type { WireClient } from "../../test/wire-client.js";
import { RELEASE_SOURCE, RUNNING_PLATFORM } from "./channel.js";

/**
 * Reading the release channel through the primary seam (launcher-update
 * spec, "Reading the channel" and "The target"; #346): the in-process
 * environment under the manual clock, its release source the fake one on
 * the fake forge, reached through the forge account for its origin, driven
 * over the wire with `updates.check`, `updates.status`,
 * `updates.settings.set` and `setup.check`.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const releaseSource = async (): Promise<FakeReleaseSource> => {
  const fake = await startFakeReleaseSource();
  onCleanup(() => fake.forge.close());
  return fake;
};

const start = async (options: TestEnvironmentOptions = {}): Promise<TestEnvironment> => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  return t;
};

/** An environment running `harnessVersion` whose release source is a fake one it has a forge account for. */
const withChannel = async (harnessVersion = "0.4.1", options: TestEnvironmentOptions = {}) => {
  const fake = await releaseSource();
  const t = await start({ harnessVersion, releaseSource: fake.source, forgeFetch: fake.forge.fetch, ...options });
  const client = await t.client();
  await fake.grantAccess(client);
  return { fake, t, client };
};

const setUpdates = (client: WireClient, values: UpdateSettingsPatch) => client.request("updates.settings.set", { commandId: randomUUID(), values });

/** The channel's part of `updates.status`. */
const channelOf = (status: UpdatesStatus) => ({ newest: status.newest, lastCheck: status.lastCheck, target: status.target, passedOver: status.passedOver });

/**
 * The status once the check a settings change began has ended: `updates.check` answers the check under way, or,
 * within its minute, the one that has ended.
 */
const afterSettings = (client: WireClient): Promise<UpdatesStatus> => client.request("updates.check", {});

/** Resolves once `updates.status` answers a check at or after `since` has ended; polls in real time. */
const checked = async (client: WireClient, since = 0): Promise<UpdatesStatus> => {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const status = await client.request("updates.status", {});
    if (status.lastCheck !== null && Date.parse(status.lastCheck.at) >= since) return status;
    if (Date.now() > deadline) throw new Error("No check ended in time.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** How many times the release list was read. */
const listReads = (fake: FakeReleaseSource) => fake.reads().filter((request) => request.path === "/api/v1/repos/david/agent-harness/releases").length;

const ok = { at: MANUAL_CLOCK_START, result: "ok" } as const;

/** The manual clock's time `ms` after its start. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

describe("the release source", () => {
  it("is compiled into the build as the project's public GitHub, and updates.status says where the releases are read", async () => {
    expect(RELEASE_SOURCE).toEqual({ origin: "https://github.com", kind: "github", repository: "david-systemtech/agent-harness" });
    const { fake, client } = await withChannel();
    expect((await client.request("updates.status", {})).releaseSource).toEqual(fake.source);
  });
});

describe("reading the channel", () => {
  it("reads the newest 50 releases that are not drafts through the forge account, orders them by precedence and passes over a tag that is not a version; stable takes the newest without a prerelease part", async () => {
    const { fake, client } = await withChannel("0.4.1");
    // Published in this order: the forge lists the last first, which is not the order of precedence.
    fake.publish({ version: "0.5.1" }, { version: "0.6.0-beta.1" }, { version: "0.5.0" }, { version: "9.0.0", tag: "nightly" }, { version: "0.7.0", draft: true });

    const status = await client.request("updates.check", {});
    expect(channelOf(status)).toEqual({ newest: "0.5.1", lastCheck: ok, target: { version: "0.5.1", source: "channel" }, passedOver: null });
    expect(fake.reads()).toEqual([
      { method: "GET", path: "/api/v1/repos/david/agent-harness/releases", query: "limit=50", scheme: "token" },
      { method: "GET", path: "/david/agent-harness/releases/download/v0.5.1/release.json", scheme: "token" },
    ]);
  });

  it("on beta takes the newest of all, prereleases included", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.1" }, { version: "0.6.0-beta.2" }, { version: "0.6.0-beta.10" });
    await setUpdates(client, { "updates.channel": "beta" });
    expect(channelOf(await afterSettings(client))).toEqual({ newest: "0.6.0-beta.10", lastCheck: ok, target: { version: "0.6.0-beta.10", source: "channel" }, passedOver: null });
  });

  it("targets nothing when the channel's newest is not newer than what runs, reading no manifest", async () => {
    const { fake, client } = await withChannel("0.5.1");
    fake.publish({ version: "0.5.0" }, { version: "0.5.1" });
    expect(channelOf(await client.request("updates.check", {}))).toEqual({ newest: "0.5.1", lastCheck: ok, target: null, passedOver: null });
    expect(fake.reads().map((request) => request.path)).toEqual(["/api/v1/repos/david/agent-harness/releases"]);
  });

  it("targets nothing with auto-update off, reading the channel's newest all the same", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0" });
    await setUpdates(client, { "updates.autoUpdate": false });
    expect(channelOf(await afterSettings(client))).toEqual({ newest: "0.5.0", lastCheck: ok, target: null, passedOver: null });
  });

  it("switched from beta to stable, targets nothing until stable passes what runs: nothing moves backwards on its own", async () => {
    const { fake, t, client } = await withChannel("0.6.0-beta.1");
    fake.publish({ version: "0.5.1" }, { version: "0.6.0-beta.1" });
    await setUpdates(client, { "updates.channel": "beta" });
    expect(channelOf(await afterSettings(client))).toMatchObject({ newest: "0.6.0-beta.1", target: null });

    await setUpdates(client, { "updates.channel": "stable" });
    expect(channelOf(await afterSettings(client))).toMatchObject({ newest: "0.5.1", target: null, passedOver: null });

    fake.publish({ version: "0.6.0" });
    t.clock.advance(MINUTE);
    expect(channelOf(await client.request("updates.check", {}))).toMatchObject({ newest: "0.6.0", target: { version: "0.6.0", source: "channel" } });
  });

  it("reads the target's manifest and checks it against its schema: one that is not JSON, not a manifest, of another version, or missing fails the check with the reason manifest", async () => {
    const cases = [
      { manifest: "{ not json", message: /is not JSON/ },
      { manifest: { databaseSchemaVersion: -1 }, message: /is not a release manifest/ },
      { manifest: { version: "0.5.2" }, message: /names the version 0\.5\.2/ },
      { manifest: null, message: /publishes no release\.json/ },
    ] as const;
    for (const { manifest, message } of cases) {
      const { fake, client } = await withChannel("0.4.1");
      fake.publish({ version: "0.5.0", manifest });
      const { lastCheck, target } = await client.request("updates.check", {});
      expect(lastCheck, JSON.stringify(manifest)).toMatchObject({ result: "failed", reason: "manifest", message: expect.stringMatching(message) as unknown as string });
      expect(target).toBeNull();
    }
  });
});

describe("the schema and artefact rules", () => {
  it("never targets a release whose database schema is below the database's, passing it over as schema, and downloads nothing of it but its manifest", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0", manifest: { databaseSchemaVersion: DATABASE_SCHEMA_VERSION - 1 } });
    expect(channelOf(await client.request("updates.check", {}))).toEqual({
      newest: "0.5.0",
      lastCheck: ok,
      target: null,
      passedOver: { version: "0.5.0", source: "channel", reason: "schema", message: expect.stringContaining(`${DATABASE_SCHEMA_VERSION - 1}, is below this database's, ${DATABASE_SCHEMA_VERSION}`) as unknown as string },
    });
    expect(fake.reads().filter((request) => request.path.includes("/releases/download/")).map((request) => request.path)).toEqual(["/david/agent-harness/releases/download/v0.5.0/release.json"]);
  });

  it("targets a release whose schema is above the database's", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0", manifest: { databaseSchemaVersion: DATABASE_SCHEMA_VERSION + 3 } });
    expect((await client.request("updates.check", {})).target).toEqual({ version: "0.5.0", source: "channel" });
  });

  it("passes over a release with no artefact for this platform", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0", manifest: { assets: [{ name: "agent-harness-plan9-x64.tar.gz", kind: "environment", platform: "plan9-x64", format: "tar.gz", size: 1, sha256: "c".repeat(64) }] } });
    expect(channelOf(await client.request("updates.check", {}))).toMatchObject({
      target: null,
      passedOver: { version: "0.5.0", source: "channel", reason: "artefact", message: `The release 0.5.0 has no artefact for ${RUNNING_PLATFORM}.` },
    });
  });
});

describe("when the channel is checked", () => {
  it("first two minutes after the start, then hourly", async () => {
    const { fake, t, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0" });
    t.clock.advance(2 * MINUTE - 1);
    expect(listReads(fake)).toBe(0);
    expect((await client.request("updates.status", {})).lastCheck).toBeNull();

    t.clock.advance(1);
    const first = await checked(client);
    expect(first.lastCheck).toEqual({ at: new Date(Date.parse(MANUAL_CLOCK_START) + 2 * MINUTE).toISOString(), result: "ok" });
    expect(first.target).toEqual({ version: "0.5.0", source: "channel" });
    expect(listReads(fake)).toBe(1);

    t.clock.advance(HOUR - 1);
    expect(listReads(fake)).toBe(1);
    t.clock.advance(1);
    await checked(client, Date.parse(MANUAL_CLOCK_START) + 2 * MINUTE + HOUR);
    expect(listReads(fake)).toBe(2);
  });

  it("on updates.check, which answers the status; a second call within a minute answers the first's result without reading the forge", async () => {
    const { fake, t, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0" });
    const first = await client.request("updates.check", {});
    expect(first.target).toEqual({ version: "0.5.0", source: "channel" });
    expect(first).toEqual(await client.request("updates.status", {}));
    expect(listReads(fake)).toBe(1);

    fake.publish({ version: "0.5.1" });
    t.clock.advance(MINUTE - 1);
    expect(channelOf(await client.request("updates.check", {}))).toEqual(channelOf(first));
    expect(listReads(fake)).toBe(1);

    t.clock.advance(1);
    const again = await client.request("updates.check", {});
    expect(listReads(fake)).toBe(2);
    expect(again).toMatchObject({ newest: "0.5.1", target: { version: "0.5.1", source: "channel" }, lastCheck: { at: new Date(Date.parse(MANUAL_CLOCK_START) + MINUTE).toISOString(), result: "ok" } });
  });

  it("answers two calls at once with the one check", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0" });
    const [first, second] = await Promise.all([client.request("updates.check", {}), client.request("updates.check", {})]);
    expect(second).toEqual(first);
    expect(listReads(fake)).toBe(1);
  });

  it("answers a read-only client session", async () => {
    const { t } = await withChannel("0.4.1");
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read"], ceiling: "plan" }).token });
    expect((await reader.request("updates.check", {})).lastCheck).toMatchObject({ result: "ok" });
  });
});

describe("a failed check", () => {
  /** The environment stream's events after `from`, up to where a subscriber is synchronized. */
  const environmentEvents = async (client: WireClient, from: number): Promise<string[]> => {
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: from });
    const mine = (frame: Frame) => "subscription" in frame && frame.subscription === subscription;
    await client.next((frame) => frame.type === "synchronized" && mine(frame));
    return client.received.flatMap((frame) => (frame.type === "event" && mine(frame) ? [frame.event.type] : []));
  };

  it("when the private forge refuses an anonymous read reports no_release_access and raises no update notice", async () => {
    const fake = await releaseSource();
    fake.publish({ version: "0.5.0" });
    const t = await start({ harnessVersion: "0.4.1", releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const client = await t.client();
    const from = t.env.log.head();
    const { lastCheck, target } = await client.request("updates.check", {});
    expect(lastCheck).toEqual({
      at: MANUAL_CLOCK_START,
      result: "failed",
      reason: "no_release_access",
      message: expect.stringContaining("it refused an anonymous read (HTTP 401)") as unknown as string,
    });
    expect(target).toBeNull();
    expect(fake.reads()).toEqual([{ method: "GET", path: "/api/v1/repos/david/agent-harness/releases", query: "limit=50", scheme: null }]);
    expect((await environmentEvents(client, from)).filter((type) => type.startsWith("environment.update"))).toEqual([]);
  });

  it("with a token the forge refuses reads no_release_access, with the forge's answer", async () => {
    const fake = await releaseSource();
    fake.publish({ version: "0.5.0" });
    const t = await start({ harnessVersion: "0.4.1", releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const client = await t.client();
    // A token the forge knows as David, which the release source does not answer.
    fake.forge.user(OTHER_TOKEN, { login: "david", id: 42 });
    await client.request("forge.accounts.add", { commandId: randomUUID(), forgeAccountId: randomUUID(), url: fake.forge.origin, kind: "forgejo", credential: pasted(OTHER_TOKEN) });
    const from = t.env.log.head();
    const { lastCheck } = await client.request("updates.check", {});
    expect(lastCheck).toMatchObject({ result: "failed", reason: "no_release_access", message: expect.stringContaining("HTTP 401") as unknown as string });
    expect((await environmentEvents(client, from)).filter((type) => !type.startsWith("forge.account."))).toEqual([]);
  });

  it("with the forge unreachable reads unreachable, and keeps the newest and the target the last check that read the channel found", async () => {
    const { fake, t, client } = await withChannel("0.4.1");
    fake.publish({ version: "0.5.0" });
    await client.request("updates.check", {});
    await fake.forge.close();
    t.clock.advance(MINUTE);
    const failed = await client.request("updates.check", {});
    expect(channelOf(failed)).toEqual({
      newest: "0.5.0",
      lastCheck: { at: new Date(Date.parse(MANUAL_CLOCK_START) + MINUTE).toISOString(), result: "failed", reason: "unreachable", message: expect.stringContaining(fake.forge.origin) as unknown as string },
      target: { version: "0.5.0", source: "channel" },
      passedOver: null,
    });
  });

  it("with the forge failing reads unreachable", async () => {
    const { fake, client } = await withChannel("0.4.1");
    fake.forge.answer("token-for-tests", "GET /api/v1/repos/david/agent-harness/releases", { status: 500, body: { message: "The database is down" } });
    expect((await client.request("updates.check", {})).lastCheck).toMatchObject({ result: "failed", reason: "unreachable" });
  });
});

describe("a pin", () => {
  it("targets its exact version on either channel, older than what runs or a prerelease on stable, with auto-update off; cleared, the target follows the switch again", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.4.2" }, { version: "0.5.0" }, { version: "0.6.0-beta.1" }, { version: "0.5.1" });
    expect((await setUpdates(client, { "updates.pinnedVersion": "0.4.2" })).receipt).toMatchObject({ status: "accepted" });
    expect(channelOf(await afterSettings(client))).toMatchObject({ newest: "0.5.1", target: { version: "0.4.2", source: "pin" } });

    await setUpdates(client, { "updates.pinnedVersion": "0.6.0-beta.1" });
    expect(channelOf(await afterSettings(client))).toMatchObject({ newest: "0.5.1", target: { version: "0.6.0-beta.1", source: "pin" } });

    await setUpdates(client, { "updates.pinnedVersion": null });
    expect(channelOf(await afterSettings(client))).toMatchObject({ target: { version: "0.5.1", source: "channel" } });
    await setUpdates(client, { "updates.autoUpdate": false });
    expect(channelOf(await afterSettings(client))).toMatchObject({ target: null });
  });

  it("targets nothing while it names the version that runs", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.5.0" }, { version: "0.5.1" });
    await setUpdates(client, { "updates.pinnedVersion": "0.5.0" });
    expect(channelOf(await afterSettings(client))).toMatchObject({ newest: "0.5.1", target: null, passedOver: null });
  });

  it("reads a pinned release older than the newest 50 by its tag", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.1.0" }, ...Array.from({ length: 50 }, (_, index) => ({ version: `0.2.${index}` })));
    // The fake lists every release on one page; the environment keeps the newest 50 it asked for.
    expect((await setUpdates(client, { "updates.pinnedVersion": "0.1.0" })).receipt).toMatchObject({ status: "accepted" });
    expect(fake.reads().map((request) => request.path)).toContain("/api/v1/repos/david/agent-harness/releases/tags/v0.1.0");
    expect((await afterSettings(client)).target).toEqual({ version: "0.1.0", source: "pin" });
  });

  it("is refused not_found when its release is missing or a draft, or has no artefact for this platform, and changes nothing", async () => {
    const { fake, t, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.5.0" }, { version: "0.6.0", draft: true });
    fake.publish({ version: "0.4.0", manifest: { assets: [{ name: "agent-harness-plan9-x64.tar.gz", kind: "environment", platform: "plan9-x64", format: "tar.gz", size: 1, sha256: "c".repeat(64) }] } });
    fake.absent("0.9.9");
    const head = t.env.log.head();
    for (const [version, message] of [
      ["0.9.9", "No release 0.9.9 is published, or it is a draft."],
      ["0.6.0", "No release 0.6.0 is published, or it is a draft."],
      ["0.4.0", `The release 0.4.0 has no artefact for ${RUNNING_PLATFORM}.`],
    ] as const) {
      const { receipt } = await setUpdates(client, { "updates.pinnedVersion": version, "updates.channel": "beta" });
      expect(receipt, version).toMatchObject({ status: "rejected", error: { code: "not_found", message: `${version} cannot be pinned: ${message}` } });
    }
    expect(t.env.log.head()).toBe(head);
    expect((await client.request("settings.get", {})).values).toMatchObject({ "updates.pinnedVersion": null, "updates.channel": "stable" });
  });

  it("is refused conflict schema when its release's database schema is below the database's", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.3.0", manifest: { databaseSchemaVersion: DATABASE_SCHEMA_VERSION - 2 } });
    const { receipt } = await setUpdates(client, { "updates.pinnedVersion": "0.3.0" });
    expect(receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "schema" }, message: expect.stringContaining("is below this database's") as unknown as string } });
  });

  it("is refused conflict with the check's reason when its release cannot be read: no release access, the forge unreachable, a manifest not its schema", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.3.0", manifest: "[]" });
    expect((await setUpdates(client, { "updates.pinnedVersion": "0.3.0" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "manifest" } } });
    await fake.forge.close();
    expect((await setUpdates(client, { "updates.pinnedVersion": "0.3.0" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "unreachable" } } });

    const privateSource = await releaseSource();
    const t = await start({ releaseSource: privateSource.source, forgeFetch: privateSource.forge.fetch });
    const bare = await t.client();
    expect((await setUpdates(bare, { "updates.pinnedVersion": "0.3.0" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "no_release_access" } } });
  });

  it("is not read again when the pin set is the one held, and unpinning reads nothing before it is set", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.4.2" });
    await setUpdates(client, { "updates.pinnedVersion": "0.4.2" });
    await afterSettings(client);
    const tagReads = () => fake.reads().length;
    const before = tagReads();
    expect((await setUpdates(client, { "updates.pinnedVersion": "0.4.2", "updates.idleWindowMinutes": 20 })).receipt).toMatchObject({ status: "accepted" });
    expect(tagReads()).toBe(before);
  });

  it("needs admin", async () => {
    const { t } = await withChannel("0.5.0");
    const reader = await t.client({ token: t.env.clientSessions.issue({ kind: "program", label: "a reader", scopes: ["read"], ceiling: "plan" }).token });
    expect(await refusal(setUpdates(reader, { "updates.pinnedVersion": "0.4.2" }))).toMatchObject({ code: "forbidden" });
  });
});

describe("the Your machines step's release channel check", () => {
  const result = async (client: WireClient) => {
    const { results } = await client.request("setup.check", { step: "your-machines" });
    return results[0];
  };

  it("is pending with auto-update on before the first scheduled channel read", async () => {
    const t = await start();
    expect(await result(await t.client())).toMatchObject({
      state: "pending",
      failing: [],
      actions: [],
      reason: "Waiting for the first release channel read, scheduled two minutes after the environment starts.",
    });
  });

  it("needs attention when the first scheduled read is overdue, after its ten-second network budget", async () => {
    const t = await start();
    const client = await t.client();
    // A missed scheduled read: moving wall time runs no scheduled callbacks.
    t.clock.jump(2 * MINUTE + 9_999);
    expect(await result(client)).toMatchObject({ state: "pending", failing: [], actions: [] });
    t.clock.jump(1);
    expect(await result(client)).toMatchObject({
      state: "needs-attention", failing: ["your-machines.release-channel"], actions: ["check-again"],
      reason: "The first scheduled release channel read is overdue: it has not completed within ten seconds of its scheduled time.",
    });
  });

  it("holds with auto-update off, or a version pinned", async () => {
    const { fake, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.4.2" });
    await setUpdates(client, { "updates.autoUpdate": false });
    expect(await result(client)).toMatchObject({ state: "done", reason: "Ready on 0.5.0, updates off, reachable from this machine only." });
    await setUpdates(client, { "updates.autoUpdate": true, "updates.pinnedVersion": "0.4.2" });
    expect(await result(client)).toMatchObject({ state: "done", reason: "Ready on 0.5.0, updates pinned to 0.4.2, reachable from this machine only." });
  });

  it("holds for 24 hours after a check succeeded, across a restart, and then needs attention with the last failure", async () => {
    const dataDir = join(tempDir(), "data");
    const fake = await releaseSource();
    fake.publish({ version: "0.5.0" });
    const first = await startTestEnvironment({ dataDir, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const admin = await first.client();
    await fake.grantAccess(admin);
    expect((await admin.request("updates.check", {})).lastCheck).toMatchObject({ result: "ok" });
    expect(await result(admin)).toMatchObject({ state: "done" });
    await first.close();

    await fake.forge.close();
    const second = await start({ dataDir, releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const client = await second.client();
    second.clock.advance(24 * HOUR - MINUTE);
    expect((await checked(client)).lastCheck).toMatchObject({ result: "failed", reason: "unreachable" });
    expect(await result(client)).toMatchObject({ state: "done" });

    second.clock.advance(MINUTE + 1);
    expect(await result(client)).toMatchObject({
      state: "needs-attention",
      failing: ["your-machines.release-channel"],
      actions: ["check-again"],
      reason: expect.stringMatching(/^The release channel has not been read in the last 24 hours: The forge at .* could not be reached/) as unknown as string,
    });
  });

  /**
   * Subscribes `client` to the environment stream from its start: each call answers the next result of Your machines a
   * `setup.result-changed` notice carries, the start pass's first, as the environment checked it with nobody asking.
   */
  const machinesResults = async (client: WireClient): Promise<() => Promise<StepResult>> => {
    const { subscription } = await client.subscribe("environment.subscribe", { afterSequence: 0 });
    const isMachinesResult = (f: Frame): f is EventFrame =>
      f.type === "event" && f.subscription === subscription && f.event.type === "setup.result-changed" && StepResult.parse(f.event.payload).step === "your-machines";
    return async () => StepResult.parse((await client.next(isMachinesResult)).event.payload);
  };

  const notReadYet = "Waiting for the first release channel read, scheduled two minutes after the environment starts.";

  it("is checked again within a second of the channel's first read, two minutes after the start, not an hour on at its cadence, though the read appends nothing (#679)", async () => {
    // The channel's newest is what runs: the read stages nothing, so no update notice triggers the step.
    const { fake, t, client } = await withChannel("0.5.0");
    fake.publish({ version: "0.5.0" });
    await t.env.setup.startPass;
    const next = await machinesResults(client);
    expect(await next()).toMatchObject({ state: "pending", failing: [], reason: notReadYet, checkedAt: MANUAL_CLOCK_START });

    t.clock.advance(2 * MINUTE);
    // Answers once the check the clock began, the channel's first read, has ended.
    expect((await client.request("updates.check", {})).lastCheck).toEqual({ at: after(2 * MINUTE), result: "ok" });
    t.clock.advance(1_000);
    expect(await next()).toMatchObject({ state: "done", failing: [], checkedAt: after(2 * MINUTE + 1_000) });
  });

  it("is checked again within a second of a check of the channel that failed, and says why it failed (#679)", async () => {
    // The private forge refuses an anonymous read of the channel.
    const fake = await releaseSource();
    const t = await start({ harnessVersion: "0.5.0", releaseSource: fake.source, forgeFetch: fake.forge.fetch });
    const client = await t.client();
    await t.env.setup.startPass;
    const next = await machinesResults(client);
    expect(await next()).toMatchObject({ state: "pending", reason: notReadYet });

    t.clock.advance(2 * MINUTE);
    const { lastCheck } = await client.request("updates.check", {});
    expect(lastCheck).toMatchObject({ at: after(2 * MINUTE), result: "failed", reason: "no_release_access" });
    t.clock.advance(1_000);
    expect(await next()).toMatchObject({
      state: "needs-attention",
      failing: ["your-machines.release-channel"],
      reason: `The release channel has not been read yet: ${lastCheck?.result === "failed" ? lastCheck.message : ""}`,
      checkedAt: after(2 * MINUTE + 1_000),
    });
  });
});
