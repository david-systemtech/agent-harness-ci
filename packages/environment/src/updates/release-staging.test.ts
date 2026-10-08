import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTCOME_RECORD_FILE,
  STAGING_DIRECTORY,
  type EnvironmentMessage,
  type OutcomeRecord,
  type ParamsOf,
  type ReleaseAsset,
  type UpdateSettingsPatch,
} from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { serverArtefact } from "../../test/artefacts.js";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { gate } from "../../test/fake-adapter.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher, type TestLauncherOptions } from "../../test/launcher.js";
import { ARTEFACT, DATABASE_SCHEMA_VERSION, sha256Of, startFakeReleaseSource, type FakeRelease, type FakeReleaseSource } from "../../test/release-source.js";
import { TOKEN } from "../../test/forge.js";
import type { WireClient } from "../../test/wire-client.js";
import { RUNNING_PLATFORM } from "./channel.js";

/**
 * Staging a release (launcher-update spec, "Staging", "Waiting", "The
 * target" and the stepping stones; #347) through the primary seam: the
 * in-process environment under the manual clock and a scripted launcher
 * channel that answers `install?` and reports its launcher protocol, its
 * release source the fake one on the fake forge, reached through the forge
 * account for its origin, driven over the wire.
 */

const { onCleanup, tempDir } = useCleanups();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The version the tests' environments run as. */
const RUNNING = "0.4.1";

/** The instant `ms` after the manual clock's start. */
const at = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

type StartOptions = TestEnvironmentOptions & { readonly launch?: TestLauncherOptions };

/** An environment running RUNNING under a launcher, whose release source is a fake one it has the forge account for. */
const withReleases = async (options: StartOptions = {}) => {
  const fake = await startFakeReleaseSource();
  onCleanup(() => fake.forge.close());
  const t = await start(fake, options);
  const client = await t.client();
  await fake.grantAccess(client);
  return { fake, t, client };
};

/** Starts an environment on `fake`'s releases, under a launcher scripted by `launch`. */
const start = async (fake: FakeReleaseSource, options: StartOptions = {}): Promise<TestEnvironment> => {
  const { launch, ...rest } = options;
  const t = await startTestEnvironment({
    harnessVersion: RUNNING,
    launcher: testLauncher({ present: true, ...launch }),
    releaseSource: fake.source,
    forgeFetch: fake.forge.fetch,
    ...rest,
  });
  onCleanup(() => t.close());
  return t;
};

/** A release of `version` serving a real server artefact of it (`test/artefacts.ts`), listed in its manifest with its size and SHA-256. */
const release = (version: string, fields: Omit<FakeRelease, "version"> = {}): FakeRelease => ({
  version,
  artefact: readFileSync(serverArtefact(tempDir("agent-harness-artefact-"), version)),
  ...fields,
});

/** This platform's artefact as a manifest lists it for `bytes`, with `fields` over it. */
const artefactEntry = (bytes: Uint8Array, fields: Partial<ReleaseAsset> = {}): ReleaseAsset => ({
  name: ARTEFACT,
  kind: "environment",
  platform: RUNNING_PLATFORM,
  format: "tar.gz",
  size: bytes.byteLength,
  sha256: sha256Of(bytes),
  ...fields,
});

/** A launcher speaking launcher protocol `protocol`, as its `versions?` reports it. */
const launcherSpeaking = (protocol: number, version = RUNNING): TestLauncherOptions => ({
  versions: () => ({ type: "versions", installed: [version], launcherVersion: RUNNING, launcherProtocol: protocol }),
});

/** Starts a run that runs until the test ends it: the environment is busy. */
const busy = (t: TestEnvironment, run = "r1"): void => {
  t.runs.start(run);
  t.runs.running(run);
};

/** The update notices the log holds, oldest first, as type and payload. */
const updateNotices = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kinds: ["environment"] })
    .filter((event) => event.type.startsWith("environment.update"))
    .map((event) => ({ type: event.type, payload: event.payload }));

/** The `install?` requests the launcher was sent: each version, and where it was staged. */
const installs = (t: TestEnvironment) =>
  t.launcher.received.flatMap((message: EnvironmentMessage) => (message.type === "install?" ? [{ version: message.version, staged: message.staged }] : []));

/** The `switch?` requests the launcher was sent. */
const switches = (t: TestEnvironment) =>
  t.launcher.received.flatMap((message: EnvironmentMessage) => (message.type === "switch?" ? [{ updateId: message.updateId, version: message.version }] : []));

/** The paths of the artefact downloads the release source served. */
const artefactReads = (fake: FakeReleaseSource) => fake.reads().filter((request) => request.path.endsWith(`/${ARTEFACT}`));

const check = (client: WireClient) => client.request("updates.check", {});

describe("staging the target a check finds", () => {
  it("downloads this platform's artefact through the forge account, unpacks it into the staging area and sends install?, busy as the environment is; the installed target is pending from the channel and waits for idle", async () => {
    let unpacked: string | undefined;
    const { fake, t, client } = await withReleases({
      launch: {
        install: (request) => {
          unpacked = readFileSync(join(request.staged, "VERSION"), "utf8");
          return { type: "installed" };
        },
      },
    });
    busy(t);
    fake.publish(release("0.5.0"));

    const status = await check(client);

    expect(status.lastCheck).toEqual({ at: MANUAL_CLOCK_START, result: "ok" });
    expect(artefactReads(fake)).toEqual([{ method: "GET", path: `/david/agent-harness/releases/download/v0.5.0/${ARTEFACT}`, scheme: "token" }]);
    expect(installs(t)).toEqual([{ version: "0.5.0", staged: join(t.dataDir, STAGING_DIRECTORY, "0.5.0") }]);
    expect(unpacked).toBe("0.5.0\n");
    // Nothing of the download is left beside the staged version.
    expect(readdirSync(join(t.dataDir, STAGING_DIRECTORY))).toEqual(["0.5.0"]);
    const [pending] = updateNotices(t);
    expect(pending).toEqual({
      type: "environment.update-pending",
      payload: { updateId: expect.any(String) as unknown as string, toVersion: "0.5.0", source: "channel", since: at(0), deferUntil: at(24 * HOUR) },
    });
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.5.0", source: "channel", waitsOn: { reason: "run-running", until: null } });

    t.runs.end("r1");
    t.clock.advance(10 * MINUTE);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { toVersion: "0.5.0", cause: "idle" } });
    await t.env.drained;
    expect(switches(t)).toEqual([{ updateId: (pending?.payload as { updateId: string }).updateId, version: "0.5.0" }]);
  });

  it("stages an idle environment's target too, which then drains at once", async () => {
    const { fake, t, client } = await withReleases();
    fake.publish(release("0.5.0"));
    // Idle a minute in, before the first scheduled check at two.
    await setUpdates(client, { "updates.idleWindowMinutes": 1 });
    t.clock.advance(MINUTE);
    expect((await client.request("environment.status", {})).activity).toEqual({ state: "idle" });

    // The check's own answer goes with the environment, which drains for the update the check staged.
    void check(client);
    await vi.waitFor(() => expect(updateNotices(t)).toHaveLength(2));
    const notices = updateNotices(t);
    expect(notices.map((notice) => [notice.type, (notice.payload as { cause?: string }).cause])).toEqual([
      ["environment.update-pending", undefined],
      ["environment.update-started", "idle"],
    ]);
    expect(installs(t)).toEqual([{ version: "0.5.0", staged: join(t.dataDir, STAGING_DIRECTORY, "0.5.0") }]);
    t.clock.advance(0);
    await t.env.drained;
    expect((await client.closed).bye).toMatchObject({ reason: "updating" });
    expect(switches(t)).toEqual([{ updateId: idOf(notices[0]), version: "0.5.0" }]);
  });

  it("leaves nothing pending when the artefact does not match the SHA-256 or the size its manifest lists, does not download, or the launcher refuses it, says why on updates.status, and tries again at the next check", async () => {
    const download = `GET /david/agent-harness/releases/download/v0.5.0/${ARTEFACT}`;
    const cases: readonly { name: string; publish: (fake: FakeReleaseSource, good: FakeRelease, bytes: Uint8Array) => void; reason: string; message: RegExp }[] = [
      {
        name: "digest",
        publish: (fake, good, bytes) => fake.publish({ ...good, manifest: { assets: [artefactEntry(bytes, { sha256: "f".repeat(64) })] } }),
        reason: "artefact",
        message: /^The artefact .* of 0\.5\.0 does not match the SHA-256 its manifest lists\.$/,
      },
      {
        name: "size",
        publish: (fake, good, bytes) => fake.publish({ ...good, manifest: { assets: [artefactEntry(bytes, { size: bytes.byteLength + 1 })] } }),
        reason: "artefact",
        message: /^The artefact .* of 0\.5\.0 is \d+ bytes, and its manifest lists \d+\.$/,
      },
      {
        name: "missing",
        publish: (fake, good) => (fake.publish(good), fake.forge.answer(TOKEN, download, { status: 404, body: { message: "Not Found" } })),
        reason: "artefact",
        message: /^The artefact of 0\.5\.0 did not download: .*HTTP 404/,
      },
      {
        // A sign-in proxy in front of the forge refusing the download (#476).
        name: "access",
        publish: (fake, good) => (fake.publish(good), fake.forge.answer(TOKEN, download, { status: 401, body: { message: "Unauthorized" } })),
        reason: "no_release_access",
        message: /^The artefact of 0\.5\.0 did not download: .*HTTP 401/,
      },
      { name: "install", publish: (fake, good) => fake.publish(good), reason: "install", message: /^The launcher refused to install 0\.5\.0: preflight\.$/ },
    ];
    for (const { name, publish, reason, message } of cases) {
      let refuse = name === "install";
      const { fake, t, client } = await withReleases({ launch: { install: () => (refuse ? { type: "refused", reason: "preflight" } : { type: "installed" }) } });
      busy(t);
      const good = release("0.5.0");
      publish(fake, good, good.artefact as Uint8Array);

      const failed = await check(client);

      expect(failed.lastCheck, name).toEqual({ at: MANUAL_CLOCK_START, result: "failed", reason, message: expect.stringMatching(message) as unknown as string });
      expect(failed.target, name).toEqual({ version: "0.5.0", source: "channel" });
      expect(failed.pending, name).toEqual({ state: "current" });
      expect(updateNotices(t), name).toEqual([]);
      expect(readdirSync(join(t.dataDir, STAGING_DIRECTORY)), name).toEqual([]);

      // The next check tries again: the release is whole again, or the launcher takes it now.
      refuse = false;
      fake.publish(good);
      t.clock.advance(MINUTE);
      const again = await check(client);
      expect(again.lastCheck, name).toEqual({ at: at(MINUTE), result: "ok" });
      expect(again.pending, name).toMatchObject({ state: "waiting", toVersion: "0.5.0", source: "channel" });
    }
  });
});

/** Sets update settings through the one method that writes them. */
const setUpdates = (client: WireClient, values: UpdateSettingsPatch) => client.request("updates.settings.set", { commandId: randomUUID(), values });

/** The update id a pending update notice names. */
const idOf = (notice: { readonly payload: unknown } | undefined): string => (notice?.payload as { updateId: string }).updateId;

/**
 * Changes the settings to `values` and expects that change to have withdrawn
 * the waiting `update`: update-cancelled, cause settings, appended by the
 * command that changed them, and nothing of it pending after.
 */
const expectWithdrawnBy = async (t: TestEnvironment, client: WireClient, values: UpdateSettingsPatch, update: { readonly updateId: string; readonly toVersion: string }) => {
  const label = JSON.stringify(values);
  const { receipt } = await setUpdates(client, values);
  expect(receipt, label).toMatchObject({ status: "accepted" });
  const cancelled = t.env.log.readStream({ kinds: ["environment"] }).find((event) => event.type === "environment.update-cancelled");
  expect(cancelled?.payload, label).toEqual({ ...update, cause: "settings" });
  const updated = t.env.log.readStream({ kinds: ["settings"] }).at(-1);
  expect(updated?.type, label).toBe("settings.updated");
  expect(cancelled?.commandId, label).toBe(updated?.commandId ?? "none");
  expect((await client.request("updates.status", {})).pending, label).not.toMatchObject({ updateId: update.updateId });
};

describe("the pending update a check stages", () => {
  it("comes from the pin when a version is pinned, on either channel", async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.4.5"), release("0.5.0"));
    await setUpdates(client, { "updates.pinnedVersion": "0.4.5" });
    const status = await check(client);
    expect(status.target).toEqual({ version: "0.4.5", source: "pin" });
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.4.5", source: "pin" });
    expect(updateNotices(t).map((notice) => notice.payload)).toEqual([expect.objectContaining({ toVersion: "0.4.5", source: "pin" })]);
  });

  it("is replaced by a newer release under a new update id that keeps since and deferUntil, with no cancellation; a check finding it pending already downloads nothing", async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.5.0"));
    await check(client);
    const first = updateNotices(t)[0];

    t.clock.advance(3 * HOUR);
    await check(client);
    expect(artefactReads(fake)).toHaveLength(1);
    expect(updateNotices(t)).toHaveLength(1);

    fake.publish(release("0.5.1"));
    t.clock.advance(HOUR);
    const status = await check(client);
    const notices = updateNotices(t);
    expect(notices.map((notice) => notice.type)).toEqual(["environment.update-pending", "environment.update-pending"]);
    expect(idOf(notices[1])).not.toBe(idOf(first));
    expect(notices[1]?.payload).toEqual({ updateId: idOf(notices[1]), toVersion: "0.5.1", source: "channel", since: at(0), deferUntil: at(24 * HOUR) });
    expect(status.pending).toMatchObject({ state: "waiting", updateId: idOf(notices[1]), toVersion: "0.5.1", since: at(0), deferUntil: at(24 * HOUR) });
    // The cap still counts from the first: at 24 hours the busy environment drains for 0.5.1.
    t.clock.advance(20 * HOUR);
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-started", payload: { updateId: idOf(notices[1]), toVersion: "0.5.1", cause: "cap" } });
  });

  it("keeps its since across a restart and a newer release after it", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await withReleases({ dataDir });
    busy(t);
    fake.publish(release("0.5.0"));
    await check(client);
    t.clock.advance(5 * HOUR);
    await t.close();

    fake.publish(release("0.5.1"));
    const again = await start(fake, { dataDir, clock: t.clock });
    busy(again);
    const status = await check(await again.client());
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.5.1", since: at(0), deferUntil: at(24 * HOUR) });
  });

  it("does not replace an update a person asked for with an older release", async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.5.0"), release("0.6.0-beta.1"));
    const asked = await client.request("updates.apply", { commandId: randomUUID(), version: "0.6.0-beta.1", when: "idle" });
    expect(asked.result).toMatchObject({ toVersion: "0.6.0-beta.1" });
    const status = await check(client);
    expect(status.target).toEqual({ version: "0.5.0", source: "channel" });
    expect(status.pending).toMatchObject({ state: "waiting", updateId: asked.result?.updateId, toVersion: "0.6.0-beta.1", source: "request" });
  });
});

describe("a channel's pending update", () => {
  /** An environment with the channel's 0.5.0 pending, busy; 0.4.5 published too, which a pin may name. */
  const channelPending = async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.4.5"), release("0.5.0"));
    await check(client);
    const updateId = idOf(updateNotices(t)[0]);
    return { fake, t, client, updateId };
  };

  it("is withdrawn with update-cancelled, cause settings, in the settings' own command, when auto-update is turned off, the channel changes, or a pin names another version", async () => {
    for (const values of [{ "updates.autoUpdate": false }, { "updates.channel": "beta" }, { "updates.pinnedVersion": "0.4.5" }] as const) {
      const { t, client, updateId } = await channelPending();
      await expectWithdrawnBy(t, client, values, { updateId, toVersion: "0.5.0" });
    }
  });

  it("stays when the settings still call for it: a pin naming its version, another setting changed", async () => {
    const { t, client, updateId } = await channelPending();
    await setUpdates(client, { "updates.idleWindowMinutes": 30 });
    await setUpdates(client, { "updates.pinnedVersion": "0.5.0" });
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
    expect((await client.request("updates.status", {})).pending).toMatchObject({ state: "waiting", updateId });
  });

  it("is not withdrawn when it is an update a person asked for", async () => {
    const { t, client } = await withReleases();
    busy(t);
    const asked = await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", artefactPath: serverArtefact(tempDir(), "0.5.0"), when: "idle" });
    await setUpdates(client, { "updates.autoUpdate": false });
    expect((await client.request("updates.status", {})).pending).toMatchObject({ state: "waiting", updateId: asked.result?.updateId, source: "request" });
  });
});

describe("a pin's pending update", () => {
  /** An environment with the pin's 0.4.5 pending, busy; 0.5.0 published too, the channel's newest, which a pin may name. */
  const pinPending = async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.4.5"), release("0.5.0"));
    await setUpdates(client, { "updates.pinnedVersion": "0.4.5" });
    const status = await check(client);
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.4.5", source: "pin" });
    return { fake, t, client, updateId: idOf(updateNotices(t)[0]) };
  };

  it("is withdrawn with update-cancelled, cause settings, in the settings' own command, when unpinned or pinned to another version", async () => {
    for (const values of [{ "updates.pinnedVersion": null }, { "updates.pinnedVersion": "0.5.0" }] as const) {
      const { t, client, updateId } = await pinPending();
      await expectWithdrawnBy(t, client, values, { updateId, toVersion: "0.4.5" });
    }
  });

  it("stays while the pin still names it: auto-update, the channel or another setting changed", async () => {
    const { t, client, updateId } = await pinPending();
    await setUpdates(client, { "updates.autoUpdate": false });
    await setUpdates(client, { "updates.channel": "beta" });
    await setUpdates(client, { "updates.idleWindowMinutes": 30 });
    await check(client);
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
    expect((await client.request("updates.status", {})).pending).toMatchObject({ state: "waiting", updateId, source: "pin" });
  });

  it("unpinned with auto-update off, goes neither at idle nor at the cap: nothing calls for an update", async () => {
    const { t, client, updateId } = await pinPending();
    await setUpdates(client, { "updates.autoUpdate": false });
    await expectWithdrawnBy(t, client, { "updates.pinnedVersion": null }, { updateId, toVersion: "0.4.5" });
    t.runs.end("r1");
    t.clock.advance(25 * HOUR);
    const status = await check(client);
    expect(status.pending).toMatchObject({ state: "current" });
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending", "environment.update-cancelled"]);
    expect(switches(t)).toEqual([]);
  });

  it("as the stepping stone to the pinned version, stays while the pin does and is withdrawn when unpinned", async () => {
    const { fake, t, client } = await withReleases({ launch: launcherSpeaking(1) });
    busy(t);
    fake.publish(release("0.5.0"), release("0.6.0", { manifest: { launcherProtocol: 2 } }));
    await setUpdates(client, { "updates.pinnedVersion": "0.6.0" });
    const status = await check(client);
    expect(status.target).toEqual({ version: "0.6.0", source: "pin" });
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.5.0", source: "pin" });
    const updateId = idOf(updateNotices(t)[0]);

    await setUpdates(client, { "updates.autoUpdate": false });
    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending"]);
    await expectWithdrawnBy(t, client, { "updates.pinnedVersion": null }, { updateId, toVersion: "0.5.0" });
  });
});

describe("a version whose update failed", () => {
  /** An environment that updated to 0.5.0 from the channel, whose trial failed and was rolled back: it runs RUNNING again. */
  const rolledBack = async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await withReleases({ dataDir });
    fake.publish(release("0.5.0"));
    await check(client);
    const updateId = idOf(updateNotices(t)[0]);
    t.clock.advance(10 * MINUTE);
    await t.env.drained;
    const record: OutcomeRecord = { updateId, fromVersion: RUNNING, toVersion: "0.5.0", stage: "trial", reason: "deadline" };
    writeFileSync(join(dataDir, OUTCOME_RECORD_FILE), `${JSON.stringify(record)}\n`);
    const again = await start(fake, { dataDir, clock: t.clock });
    const later = await again.client();
    busy(again);
    return { fake, t: again, client: later };
  };

  it("is never the target again, and no check downloads it; the next newer release is", async () => {
    const { fake, t, client } = await rolledBack();
    const reads = artefactReads(fake).length;
    t.clock.advance(MINUTE);
    const status = await check(client);
    expect(status.failedVersions).toEqual(["0.5.0"]);
    expect(status).toMatchObject({ newest: "0.5.0", lastCheck: { result: "ok" }, target: null, pending: { state: "current" } });
    expect(artefactReads(fake)).toHaveLength(reads);

    fake.publish(release("0.5.1"));
    t.clock.advance(MINUTE);
    expect(await check(client)).toMatchObject({ target: { version: "0.5.1", source: "channel" }, pending: { state: "waiting", toVersion: "0.5.1", source: "channel" } });
  });

  it("is not the target while pinned either", async () => {
    const { t, client } = await rolledBack();
    await setUpdates(client, { "updates.pinnedVersion": "0.5.0" });
    t.clock.advance(MINUTE);
    expect(await check(client)).toMatchObject({ target: null, pending: { state: "current" } });
  });

  it("is retried by Update now: updates.apply with its version stages it as a request", async () => {
    const { t, client } = await rolledBack();
    const { result } = await client.request("updates.apply", { commandId: randomUUID(), version: "0.5.0", when: "idle" });
    expect(result).toEqual({ updateId: expect.any(String) as unknown as string, toVersion: "0.5.0" });
    expect(updateNotices(t).at(-1)).toMatchObject({ type: "environment.update-pending", payload: { updateId: result?.updateId, toVersion: "0.5.0", source: "request" } });
  });
});

describe("a target that needs a newer launcher", () => {
  it("is reached through the newest release the running launcher hosts first, on the channel; after the handover, the next check goes onward", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await withReleases({ dataDir, launch: launcherSpeaking(1) });
    busy(t);
    fake.publish(release("0.5.0"), release("0.6.0"), release("0.6.1-beta.1"), release("0.7.0", { manifest: { launcherProtocol: 2 } }));

    const status = await check(client);
    expect(status.target).toEqual({ version: "0.7.0", source: "channel" });
    expect(status.pending).toMatchObject({ state: "waiting", toVersion: "0.6.0", source: "channel" });
    expect(artefactReads(fake).map((request) => request.path)).toEqual([`/david/agent-harness/releases/download/v0.6.0/${ARTEFACT}`]);
    t.runs.end("r1");
    t.clock.advance(10 * MINUTE);
    await t.env.drained;

    // The stepping stone runs under the old launcher, and carries a launcher that speaks protocol 2: its handover is due, not a block.
    const stone = await start(fake, { dataDir, clock: t.clock, harnessVersion: "0.6.0", launcherProtocol: 2, launch: launcherSpeaking(1, "0.6.0") });
    const before = await check(await stone.client());
    expect(before).toMatchObject({ version: "0.6.0", target: { version: "0.7.0", source: "channel" }, pending: { state: "current" } });
    expect(artefactReads(fake)).toHaveLength(1);
    await stone.close();

    // After the handover the launcher speaks protocol 2, and the next check stages the target.
    const handedOver = await start(fake, { dataDir, clock: t.clock, harnessVersion: "0.6.0", launcherProtocol: 2, launch: launcherSpeaking(2, "0.6.0") });
    busy(handedOver);
    const onward = await check(await handedOver.client());
    expect(onward.pending).toMatchObject({ state: "waiting", toVersion: "0.7.0", source: "channel" });
    expect(installs(handedOver)).toEqual([{ version: "0.7.0", staged: join(dataDir, STAGING_DIRECTORY, "0.7.0") }]);
  });

  it("after the running release's launcher handover failed, is blocked and needs attention, naming service install from the running release", async () => {
    const { fake, t, client } = await withReleases({
      harnessVersion: "0.6.0",
      launcherProtocol: 2,
      launch: {
        versions: () => ({ type: "versions", installed: ["0.6.0"], launcherVersion: RUNNING, launcherProtocol: 1, failedHandoverVersion: "0.6.0" }),
      },
    });
    fake.publish(release("0.6.0"), release("0.7.0", { manifest: { launcherProtocol: 2 } }));
    const status = await check(client);
    expect(status.lastCheck).toMatchObject({ result: "ok" });
    expect(status.target).toEqual({ version: "0.7.0", source: "channel" });
    expect(status.pending).toEqual({
      state: "blocked",
      reason: "launcher",
      toVersion: "0.7.0",
      message: "0.7.0 needs launcher protocol 2, and the launcher running this environment speaks 1: run `agent-harness service install` from the 0.6.0 release to install its launcher.",
    });
    expect(artefactReads(fake)).toEqual([]);
    expect(installs(t)).toEqual([]);
    const { results } = await client.request("setup.check", { step: "your-machines" });
    expect(results[0]).toMatchObject({
      state: "needs-attention",
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "Version 0.7.0 needs a newer installer. Reinstall agent-harness from the 0.6.0 download.",
      details: ["0.7.0 needs launcher protocol 2, and the launcher running this environment speaks 1: run `agent-harness service install` from the 0.6.0 release to install its launcher."],
    });
  });

  it("waits for the running release's handover when only another release's handover failed", async () => {
    const { fake, t, client } = await withReleases({
      harnessVersion: "0.6.0",
      launcherProtocol: 2,
      launch: {
        versions: () => ({ type: "versions", installed: ["0.6.0"], launcherVersion: RUNNING, launcherProtocol: 1, failedHandoverVersion: "0.5.0" }),
      },
    });
    fake.publish(release("0.7.0", { manifest: { launcherProtocol: 2 } }));
    expect(await check(client)).toMatchObject({ target: { version: "0.7.0", source: "channel" }, pending: { state: "current" } });
    expect(artefactReads(fake)).toEqual([]);
    expect(installs(t)).toEqual([]);
    const { results } = await client.request("setup.check", { step: "your-machines" });
    expect(results[0]).toMatchObject({ state: "done", failing: [] });
  });

  it("still takes an available stepping stone after the running release's launcher handover failed", async () => {
    const { fake, t, client } = await withReleases({
      harnessVersion: "0.6.0",
      launcherProtocol: 2,
      launch: {
        versions: () => ({ type: "versions", installed: ["0.6.0"], launcherVersion: RUNNING, launcherProtocol: 1, failedHandoverVersion: "0.6.0" }),
      },
    });
    busy(t);
    fake.publish(release("0.6.1"), release("0.7.0", { manifest: { launcherProtocol: 2 } }));
    expect(await check(client)).toMatchObject({ target: { version: "0.7.0", source: "channel" }, pending: { state: "waiting", toVersion: "0.6.1" } });
    expect(installs(t).map((request) => request.version)).toEqual(["0.6.1"]);
  });

  it("with no stepping stone, is blocked with the reason launcher, naming service install from the target's release, and downloads nothing", async () => {
    const { fake, t, client } = await withReleases({ launch: launcherSpeaking(1) });
    fake.publish(release("0.7.0", { manifest: { launcherProtocol: 2 } }));
    const status = await check(client);
    expect(status.lastCheck).toMatchObject({ result: "ok" });
    expect(status.target).toEqual({ version: "0.7.0", source: "channel" });
    expect(status.pending).toEqual({
      state: "blocked",
      reason: "launcher",
      toVersion: "0.7.0",
      message: "0.7.0 needs launcher protocol 2, and the launcher running this environment speaks 1: run `agent-harness service install` from the 0.7.0 release to install its launcher.",
    });
    expect(artefactReads(fake)).toEqual([]);
    expect(updateNotices(t)).toEqual([]);

    // Update now to it is refused the same way.
    const asked = await client.request("updates.apply", { commandId: randomUUID(), version: "0.7.0", when: "idle" });
    expect(asked.receipt).toMatchObject({
      status: "rejected",
      error: {
        code: "conflict",
        data: { reason: "launcher" },
        message: "Cannot update to 0.7.0: 0.7.0 needs launcher protocol 2, and the launcher running this environment speaks 1: run `agent-harness service install` from the 0.7.0 release to install its launcher.",
      },
    });
  });
});

/** Asks for an update with a fresh command id. */
const apply = (client: WireClient, params: Omit<ParamsOf<"updates.apply">, "commandId">) => client.request("updates.apply", { commandId: randomUUID(), ...params });

describe("updates.apply by version, with no path", () => {
  it("downloads, checks and installs that release as a request, answering its update id, and drains at once when asked now", async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.5.0"), release("0.5.1"));
    const { result } = await apply(client, { version: "0.5.0", when: "idle" });
    expect(result).toEqual({ updateId: expect.any(String) as unknown as string, toVersion: "0.5.0" });
    expect(artefactReads(fake).map((request) => request.path)).toEqual([`/david/agent-harness/releases/download/v0.5.0/${ARTEFACT}`]);
    expect(installs(t)).toEqual([{ version: "0.5.0", staged: join(t.dataDir, STAGING_DIRECTORY, "0.5.0") }]);
    expect(updateNotices(t)).toEqual([
      { type: "environment.update-pending", payload: { updateId: result?.updateId, toVersion: "0.5.0", source: "request", since: at(0), deferUntil: at(24 * HOUR) } },
    ]);

    // A newer version asked for at once replaces it, keeping since, and drains.
    const now = await apply(client, { version: "0.5.1", when: "now" });
    expect(updateNotices(t).slice(1)).toEqual([
      { type: "environment.update-pending", payload: { updateId: now.result?.updateId, toVersion: "0.5.1", source: "request", since: at(0), deferUntil: at(24 * HOUR) } },
      { type: "environment.update-started", payload: { updateId: now.result?.updateId, fromVersion: RUNNING, toVersion: "0.5.1", cause: "requested" } },
    ]);
  });

  it("with no version takes the channel's newest, or the pinned version", async () => {
    // The launcher refuses the pinned version the first time: the check the pin begins stages nothing.
    let pinRefused = false;
    const { fake, t, client } = await withReleases({
      launch: { install: (request) => (request.version === "0.4.5" && !pinRefused ? ((pinRefused = true), { type: "refused", reason: "io" }) : { type: "installed" }) },
    });
    busy(t);
    fake.publish(release("0.4.5"), release("0.5.0"), release("0.6.0-beta.1"));
    await setUpdates(client, { "updates.autoUpdate": false });
    await check(client);
    expect((await apply(client, { when: "idle" })).result).toMatchObject({ toVersion: "0.5.0" });
    await client.request("updates.cancel", { commandId: randomUUID() });
    await setUpdates(client, { "updates.pinnedVersion": "0.4.5" });
    expect((await check(client)).lastCheck).toMatchObject({ result: "failed", reason: "install" });
    expect((await apply(client, { when: "idle" })).result).toMatchObject({ toVersion: "0.4.5" });
    expect(updateNotices(t).at(-1)?.payload).toMatchObject({ toVersion: "0.4.5", source: "request" });
  });

  it("is refused not_found with no such release or no artefact for this platform, and conflict when pinned to another version, for the version running or nothing newer, below the database's schema, or without release access", async () => {
    const { fake, t, client } = await withReleases();
    fake.publish(
      release("0.4.5"),
      release("0.5.0", { manifest: { assets: [artefactEntry(new Uint8Array(1), { name: "agent-harness-plan9-x64.tar.gz", platform: "plan9-x64" })] } }),
      release("0.5.1", { manifest: { databaseSchemaVersion: DATABASE_SCHEMA_VERSION - 1 } }),
    );
    fake.absent("0.9.9");
    const refused = async (params: Omit<ParamsOf<"updates.apply">, "commandId">) => (await apply(client, params)).receipt;
    expect(await refused({ version: "0.9.9", when: "idle" })).toMatchObject({ status: "rejected", error: { code: "not_found", message: "Cannot update to 0.9.9: No release 0.9.9 is published, or it is a draft." } });
    expect(await refused({ version: "0.5.0", when: "idle" })).toMatchObject({ status: "rejected", error: { code: "not_found", message: `Cannot update to 0.5.0: The release 0.5.0 has no artefact for ${RUNNING_PLATFORM}.` } });
    expect(await refused({ version: "0.5.1", when: "idle" })).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "schema" } } });
    expect(await refused({ version: RUNNING, when: "idle" })).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "current" } } });
    await setUpdates(client, { "updates.pinnedVersion": "0.4.5" });
    expect(await refused({ version: "0.9.9", when: "idle" })).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "pinned" }, message: expect.stringContaining("0.4.5 is pinned") as unknown as string } });
    expect(updateNotices(t)).toEqual([]);
    expect(installs(t)).toEqual([]);

    const bare = await start(fake);
    expect((await apply(await bare.client(), { version: "0.4.5", when: "idle" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "no_release_access" } } });
  });

  it("with no version is refused conflict current when the channel publishes nothing newer than what runs, or the pin names the version that runs", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release("0.4.0"), release("0.4.1"));
    expect((await apply(client, { when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "current" }, message: "This environment runs 0.4.1, and nothing newer is published on the stable channel." },
    });

    fake.publish(release("0.5.0"));
    await setUpdates(client, { "updates.pinnedVersion": RUNNING });
    expect((await apply(client, { when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "current" }, message: "This environment runs 0.4.1 already." },
    });
  });

  it("is refused conflict artefact for an artefact that does not match its manifest, and install when the launcher refuses it, leaving nothing staged or pending", async () => {
    const { fake, t, client } = await withReleases({ launch: { install: (request) => (request.version === "0.5.1" ? { type: "refused", reason: "disk" } : { type: "installed" }) } });
    const good = release("0.5.0");
    fake.publish({ ...good, manifest: { assets: [artefactEntry(good.artefact as Uint8Array, { sha256: "e".repeat(64) })] } }, release("0.5.1"));
    expect((await apply(client, { version: "0.5.0", when: "idle" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "artefact" } } });
    expect((await apply(client, { version: "0.5.1", when: "idle" })).receipt).toMatchObject({
      status: "rejected",
      error: { code: "conflict", data: { reason: "install", launcherReason: "disk" } },
    });
    expect(readdirSync(join(t.dataDir, STAGING_DIRECTORY))).toEqual([]);
    expect((await client.request("updates.status", {})).pending).toEqual({ state: "current" });
  });

  it("is refused in_progress while another update is staged, and shows it staging", async () => {
    const installing = gate();
    const { fake, t, client } = await withReleases({ launch: { install: async () => (await installing.opened, { type: "installed" }) } });
    busy(t);
    fake.publish(release("0.5.0"), release("0.5.1"));
    const first = apply(client, { version: "0.5.0", when: "idle" });
    await vi.waitFor(() => expect(installs(t)).toHaveLength(1));
    expect((await client.request("updates.status", {})).pending).toMatchObject({ state: "staging", toVersion: "0.5.0", source: "request" });
    expect((await apply(client, { version: "0.5.1", when: "idle" })).receipt).toMatchObject({ status: "rejected", error: { code: "conflict", data: { reason: "in_progress" } } });
    // A check meanwhile stages nothing of its own.
    expect((await check(client)).lastCheck).toMatchObject({ result: "ok" });
    installing.open();
    expect((await first).result).toMatchObject({ toVersion: "0.5.0" });
    expect(installs(t)).toHaveLength(1);
  });
});

describe("the Your machines step's updates check", () => {
  /** The Your machines step's result, the release channel's check apart. */
  const machines = async (client: WireClient) => {
    const { results } = await client.request("setup.check", { step: "your-machines" });
    const result = results[0];
    return { failing: result?.failing.filter((id) => id !== "your-machines.release-channel"), actions: result?.actions, reason: result?.reason, details: result?.details };
  };
  /** Names the environment `name`, which the step's lines name. */
  const rename = (client: WireClient, name: string) => client.request("environment.rename", { commandId: randomUUID(), name });
  const holds = {
    failing: [],
    actions: [],
    reason: expect.stringMatching(/^.+ is ready\. (It updates itself|Automatic updates are off)\.$/) as unknown as string,
    details: expect.arrayContaining([`Version: ${RUNNING}`]) as unknown as string[],
  };

  it("holds with auto-update on, behind as the machine may be, and with it off while the channel's newest runs", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release("0.5.0"));
    await check(client);
    expect(await machines(client)).toEqual(holds);

    const { fake: current, client: other } = await withReleases();
    current.publish(release("0.4.0"), release(RUNNING));
    await setUpdates(other, { "updates.autoUpdate": false });
    await check(other);
    expect(await machines(other)).toEqual(holds);
  });

  it("needs attention with auto-update off or a version pinned while the channel's newest is newer than what runs, offering update", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release(RUNNING), release("0.4.5"), release("0.5.0"));
    await setUpdates(client, { "updates.autoUpdate": false });
    await check(client);
    expect(await machines(client)).toEqual({
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "Version 0.5.0 is available. Choose Update now.",
      details: ["Running: 0.4.1", "Newest on the channel: 0.5.0", "Updates: off"],
    });
    await setUpdates(client, { "updates.autoUpdate": true, "updates.pinnedVersion": RUNNING });
    await check(client);
    await rename(client, "Desk");
    expect(await machines(client)).toMatchObject({
      reason: `Desk stays on 0.4.1 because it is pinned. 0.5.0 is available.`,
      details: ["Running: 0.4.1", "Newest on the channel: 0.5.0", "Updates: pinned to 0.4.1"],
    });
  });

  it("does not say a machine stays on a pin it does not run yet", async () => {
    for (const pinnedVersion of ["0.4.5", "0.5.0"]) {
      const { fake, client } = await withReleases();
      fake.publish(release("0.4.5"), release("0.5.0"));
      await setUpdates(client, { "updates.pinnedVersion": pinnedVersion });
      await check(client);
      const { failing, reason } = await machines(client);
      expect(failing).toEqual([]);
      expect(reason).not.toMatch(/because it is pinned/);
    }
  });

  it("needs attention while a pin that does not run is neither staging nor pending, its install refused", async () => {
    const { fake, client } = await withReleases({ launch: { install: () => ({ type: "refused", reason: "preflight" }) } });
    fake.publish(release("0.4.9"), release("0.5.0"));
    await setUpdates(client, { "updates.pinnedVersion": "0.4.9" });
    // The check the pin began, which staged 0.4.9 and was refused; Set up's ask within its minute reads nothing again.
    await check(client);
    expect(await machines(client)).toEqual({
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "Version 0.5.0 is available. Choose Update now.",
      details: ["Running: 0.4.1", "Newest on the channel: 0.5.0", "Updates: pinned to 0.4.9"],
    });
  });

  it("needs attention while the target is blocked, saying what unblocks it", async () => {
    const { fake, client } = await withReleases();
    fake.publish(release("0.7.0", { manifest: { launcherProtocol: 2 } }));
    await check(client);
    expect(await machines(client)).toEqual({
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "Version 0.7.0 needs a newer installer. Reinstall agent-harness from the 0.7.0 download.",
      details: ["0.7.0 needs launcher protocol 2, and the launcher running this environment speaks 1: run `agent-harness service install` from the 0.7.0 release to install its launcher."],
    });
  });

  it("needs attention while a failed update leaves the machine below the version it failed to reach", async () => {
    const dataDir = join(tempDir(), "data");
    const { fake, t, client } = await withReleases({ dataDir });
    fake.publish(release("0.5.0"));
    await check(client);
    const updateId = idOf(updateNotices(t)[0]);
    t.clock.advance(10 * MINUTE);
    await t.env.drained;
    const record: OutcomeRecord = { updateId, fromVersion: RUNNING, toVersion: "0.5.0", stage: "crash-loop", reason: "exit" };
    writeFileSync(join(dataDir, OUTCOME_RECORD_FILE), `${JSON.stringify(record)}\n`);
    const again = await start(fake, { dataDir, clock: t.clock });
    const client2 = await again.client();
    await rename(client2, "Desk");
    expect(await machines(client2)).toEqual({
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "The update to 0.5.0 did not work. Desk still runs 0.4.1. Choose Update now to try again.",
      details: ["Running: 0.4.1", "Updates that did not work: 0.5.0", "Last update: to 0.5.0, failed at crash-loop: exit"],
    });
  });

  it("needs attention while a pending update is still not through its drain more than the drain's cap past its deferral cap", async () => {
    const { fake, t, client } = await withReleases();
    busy(t);
    fake.publish(release("0.5.0"));
    await check(client);
    t.clock.advance(10 * HOUR);
    expect(await machines(client)).toEqual(holds);
    // The cap lowered to an hour: the update was due nine hours ago, and drains at the next tick.
    await setUpdates(client, { "updates.deferralCapHours": 1 });
    expect(await machines(client)).toEqual({
      failing: ["your-machines.updates"],
      actions: ["update"],
      reason: "The update to 0.5.0 is waiting for running sessions to finish.",
      details: [`Update due at: ${at(HOUR)}`, "Update state: waiting"],
    });
  });
});
