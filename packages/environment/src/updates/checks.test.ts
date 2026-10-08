import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelCheckedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock, MANUAL_CLOCK_START } from "../../test/clock.js";
import type { ChannelFailure, ChannelReading, ReleaseChannelReader } from "./channel.js";
import { CHECK_AGAIN_MS, CLIENT_READ_WAIT_MS, FIRST_CHECK_MS, RELEASE_CHANNEL_FILE, RELEASE_CHANNEL_FRESH_MS, createChannelChecks, type ChannelChecksOptions } from "./checks.js";

/**
 * The channel's checks against a read held until the test lets it answer,
 * beside Update now's read of the channel (#1774): what `updates.status`
 * shows of the channel is what the read that began last found. A check that
 * changes what it shows is said on the environment's stream (#1795).
 */

const { tempDir } = useCleanups();

/** What a read finds with `newest` the channel's newest, nothing to target. */
const reading = (newest: string): ChannelReading => ({ outcome: "read", newest, target: null, passedOver: null, stage: null, blocked: null });

/** Checks over `dataDir` whose every read waits for the answer the test gives it, and which stage what they find with `follow`. */
const heldChecks = (dataDir = tempDir("agent-harness-checks-"), follow: ChannelChecksOptions["follow"] = () => Promise.resolve(null)) => {
  const clock = manualClock();
  const answers: ((read: ChannelReading | ChannelFailure) => void)[] = [];
  const said: ChannelCheckedPayload[] = [];
  let reads = 0;
  const channel: ReleaseChannelReader["read"] = () => {
    reads += 1;
    return new Promise((resolve) => answers.push(resolve));
  };
  const checks = createChannelChecks({
    clock,
    dataDir,
    channel: { read: channel } as ReleaseChannelReader,
    settings: () => ({ autoUpdate: true, channel: "stable", pinnedVersion: null }),
    context: () => Promise.resolve({ launcherProtocol: null, failedVersions: [] }),
    follow,
    said: (payload) => said.push(payload),
  });
  /** Lets the read under way answer, once it has begun. */
  const answer = async (read: ChannelReading | ChannelFailure): Promise<void> => {
    await expect.poll(() => answers.length).toBe(1);
    answers.shift()?.(read);
  };
  /** A check now, past the minute in which a repeat answers the last, which `read` answers. */
  const checked = async (read: ChannelReading | ChannelFailure): Promise<void> => {
    clock.advance(CHECK_AGAIN_MS);
    const checking = checks.check();
    await answer(read);
    await checking;
  };
  return { clock, checks, answer, checked, said, reads: () => reads };
};

/** What Set up tells the release channel's check: a client's ask wants a fresh finding, the schedule's one of the step's hour. */
const CLIENT = { maxAgeMs: 0 };
const SCHEDULE = { maxAgeMs: 60 * 60_000 };

const SECOND_LATER = new Date(Date.parse(MANUAL_CLOCK_START) + 1000);

describe("the last read of the channel (#1812)", () => {
  const unreachable = { outcome: "failed", reason: "unreachable", message: "The forge did not answer." } as const;

  it("is none before any check read it, and the start of the last check that did", async () => {
    const { clock, checks, answer, checked } = heldChecks();
    expect(checks.status()).toEqual({ newest: null, lastCheck: null, lastReadAt: null, readSinceStart: false, target: null, passedOver: null });
    await checked(reading("0.5.0"));
    const read = clock.now().toISOString();
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { at: read, result: "ok" }, lastReadAt: read });

    clock.advance(CHECK_AGAIN_MS);
    const checking = checks.check();
    await answer(unreachable);
    await checking;
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { result: "failed" }, lastReadAt: read });
  });

  it("before the first check since the start is the time kept in the data directory, beside no last check, and is kept through a check that fails", async () => {
    const dataDir = tempDir("agent-harness-checks-");
    const kept = "2026-09-23T23:48:00.000Z";
    writeFileSync(join(dataDir, RELEASE_CHANNEL_FILE), `${JSON.stringify({ lastSucceededAt: kept })}\n`);
    const { clock, checks, answer, checked } = heldChecks(dataDir);
    expect(checks.status()).toEqual({ newest: null, lastCheck: null, lastReadAt: kept, readSinceStart: false, target: null, passedOver: null });

    const checking = checks.check();
    await answer(unreachable);
    await checking;
    expect(checks.status()).toMatchObject({ newest: null, lastCheck: { result: "failed", reason: "unreachable" }, lastReadAt: kept });

    await checked(reading("0.5.0"));
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastReadAt: clock.now().toISOString() });
  });

  it("says whether a check since the start read it, through a later check that fails after one that found nothing (#1818)", async () => {
    const dataDir = tempDir("agent-harness-checks-");
    const kept = "2026-09-23T23:48:00.000Z";
    writeFileSync(join(dataDir, RELEASE_CHANNEL_FILE), `${JSON.stringify({ lastSucceededAt: kept })}\n`);
    const { clock, checks, checked } = heldChecks(dataDir);
    expect(checks.status()).toMatchObject({ readSinceStart: false, lastReadAt: kept });
    await checked(unreachable);
    expect(checks.status()).toMatchObject({ readSinceStart: false, lastReadAt: kept });

    await checked({ outcome: "read", newest: null, target: null, passedOver: null, stage: null, blocked: null });
    const read = clock.now().toISOString();
    await checked(unreachable);
    expect(checks.status()).toMatchObject({ newest: null, target: null, passedOver: null, lastCheck: { result: "failed" }, lastReadAt: read, readSinceStart: true });
  });
});

describe("Update now's read of the channel", () => {
  it("is shown as a check that found what it found, and a check that began before it and ends after it does not replace it", async () => {
    const { clock, checks, answer } = heldChecks();
    const checking = checks.check();
    clock.advance(1000);
    checks.readByRequest(reading("0.5.0"), clock.now());
    expect(checks.status()).toEqual({ newest: "0.5.0", lastCheck: { at: SECOND_LATER.toISOString(), result: "ok" }, lastReadAt: SECOND_LATER.toISOString(), readSinceStart: true, target: null, passedOver: null });

    await answer(reading("0.4.1"));
    await checking;
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { at: SECOND_LATER.toISOString(), result: "ok" } });
    expect(await checks.releaseChannelHolds(SCHEDULE)).toBe(true);
  });

  it("failed, is the last check, and a check that began before it and found a newest still shows that newest", async () => {
    const { clock, checks, answer } = heldChecks();
    const checking = checks.check();
    await answer(reading("0.4.1"));
    await checking;
    clock.advance(1000);
    checks.readByRequest({ outcome: "failed", reason: "unreachable", message: "The forge did not answer." }, clock.now());

    expect(checks.status()).toEqual({
      newest: "0.4.1",
      lastCheck: { at: SECOND_LATER.toISOString(), result: "failed", reason: "unreachable", message: "The forge did not answer." },
      lastReadAt: MANUAL_CLOCK_START,
      readSinceStart: true,
      target: null,
      passedOver: null,
    });
  });

  it("failed, does not keep a check that began before it and ends after it from showing the newest it found", async () => {
    const { clock, checks, answer } = heldChecks();
    const checking = checks.check();
    clock.advance(1000);
    checks.readByRequest({ outcome: "failed", reason: "unreachable", message: "The forge did not answer." }, clock.now());

    await answer(reading("0.5.0"));
    await checking;
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { at: SECOND_LATER.toISOString(), result: "failed", reason: "unreachable" } });
  });
});

describe("a check that changes what updates.status shows of the channel", () => {
  const unreachable: ChannelFailure = { outcome: "failed", reason: "unreachable", message: "The forge did not answer." };

  it("is said, the first and a newer newest found, and a check that finds what the last found says nothing", async () => {
    const { checks, checked, said } = heldChecks();
    await checked(reading("0.4.1"));
    await checked(reading("0.4.1"));
    await checked(reading("0.5.0"));

    expect(said).toEqual([
      { newest: "0.4.1", lastCheck: { at: expect.any(String), result: "ok" } },
      { newest: "0.5.0", lastCheck: checks.status().lastCheck },
    ]);
  });

  it("is said as the last check's result changes, failed or read again, and a failure repeated with its reason says nothing", async () => {
    const { checks, checked, said } = heldChecks();
    await checked(reading("0.4.1"));
    await checked(unreachable);
    const failed = checks.status().lastCheck;
    await checked({ ...unreachable, message: "The forge timed out." });
    await checked({ ...unreachable, reason: "no_release_access", message: "The forge refused the token." });
    const refused = checks.status().lastCheck;
    await checked(reading("0.4.1"));

    expect(said.map(({ lastCheck }) => lastCheck)).toEqual([expect.objectContaining({ result: "ok" }), failed, refused, checks.status().lastCheck]);
    expect(said.every(({ newest }) => newest === "0.4.1")).toBe(true);
  });

  it("is said for Update now's read that finds a newer newest, and not for a check that began before it and is not shown", async () => {
    const { clock, checks, answer, said } = heldChecks();
    const checking = checks.check();
    clock.advance(1000);
    checks.readByRequest(reading("0.5.0"), clock.now());
    await answer(reading("0.4.1"));
    await checking;

    expect(said).toEqual([{ newest: "0.5.0", lastCheck: { at: SECOND_LATER.toISOString(), result: "ok" } }]);
  });

  it("is not said by a check that ends once the checks stopped, as the environment closes", async () => {
    const { checks, answer, said } = heldChecks();
    const stop = checks.start();
    const checking = checks.check();
    stop();
    await answer(reading("0.5.0"));
    await checking;
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { result: "ok" } });
    expect(said).toEqual([]);
  });

  it("still ends the check when saying it throws, and the next check that finds the same says it", async () => {
    const clock = manualClock();
    let fails = true;
    const said: ChannelCheckedPayload[] = [];
    const checks = createChannelChecks({
      clock,
      dataDir: tempDir("agent-harness-checks-"),
      channel: { read: () => Promise.resolve(reading("0.5.0")) } as unknown as ReleaseChannelReader,
      settings: () => ({ autoUpdate: false, channel: "stable", pinnedVersion: null }),
      context: () => Promise.resolve({ launcherProtocol: null, failedVersions: [] }),
      follow: () => Promise.resolve(null),
      said: (payload) => {
        if (fails) throw new Error("The log is busy.");
        said.push(payload);
      },
    });
    const heard: string[] = [];
    checks.onChecked(() => heard.push("checked"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await checks.check();
    expect(checks.status()).toMatchObject({ newest: "0.5.0", lastCheck: { result: "ok" } });
    expect(heard).toEqual(["checked"]);
    expect(errors).toHaveBeenCalledWith("Saying the release channel's check on the environment's stream failed:", expect.any(Error));
    errors.mockRestore();

    fails = false;
    clock.advance(CHECK_AGAIN_MS);
    await checks.check();
    expect(said).toEqual([{ newest: "0.5.0", lastCheck: checks.status().lastCheck }]);
  });
});

describe("the Your machines step's release channel check (#1848; setup-copy.md §5.4)", () => {
  const unreachable = { outcome: "failed", reason: "unreachable", message: "The forge at https://forge.test could not be reached." } as const;
  const at = (ms: number) => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

  it("on a client's ask reads the channel again and answers from that read, before the first scheduled read is due", async () => {
    const { checks, answer, reads } = heldChecks();
    const answered = checks.releaseChannelHolds(CLIENT);
    await answer(reading("0.5.0"));
    expect(await answered).toBe(true);
    expect(reads()).toBe(1);
    expect(checks.status()).toMatchObject({ newest: "0.5.0", readSinceStart: true });
  });

  it("on a client's ask answers once the read ends, while the staging of what it found goes on", async () => {
    let staged: (() => void) | undefined;
    const { checks, answer } = heldChecks(undefined, () => new Promise((resolve) => (staged = () => resolve(null))));
    const answered = checks.releaseChannelHolds(CLIENT);
    await answer(reading("0.5.0"));
    expect(await answered).toBe(true);
    await expect.poll(() => staged).toBeDefined();
    expect(checks.status().lastCheck).toBeNull();
    staged?.();
  });

  it("on a client's ask within a minute of the last check's start answers that check's read, reading nothing again", async () => {
    const { clock, checks, answer, reads } = heldChecks();
    const first = checks.releaseChannelHolds(CLIENT);
    await answer(unreachable);
    await first;
    clock.advance(CHECK_AGAIN_MS - 1);
    expect(await checks.releaseChannelHolds(CLIENT)).toMatchObject({ reason: "agent-harness could not check for updates. Check the internet connection, then choose Check again." });
    expect(reads()).toBe(1);
  });

  it("on a client's ask answers from what is known once the read outlasts its wait, and so does an ask that joins it", async () => {
    const dataDir = tempDir("agent-harness-checks-");
    const kept = "2026-09-22T23:48:00.000Z";
    writeFileSync(join(dataDir, RELEASE_CHANNEL_FILE), `${JSON.stringify({ lastSucceededAt: kept })}\n`);
    const { clock, checks, answer, reads } = heldChecks(dataDir);
    clock.jump(RELEASE_CHANNEL_FRESH_MS);
    const stale = { reason: "agent-harness has not checked for updates in the last day. Choose Check again.", details: [`Last read of the release channel: ${kept}`] };
    const first = checks.releaseChannelHolds(CLIENT);
    clock.advance(CLIENT_READ_WAIT_MS);
    expect(await first).toEqual(stale);
    const joined = checks.releaseChannelHolds(CLIENT);
    clock.advance(CLIENT_READ_WAIT_MS);
    expect(await joined).toEqual(stale);
    expect(reads()).toBe(1);
    await answer(reading("0.5.0"));
    expect(await checks.releaseChannelHolds(SCHEDULE)).toBe(true);
  });

  it("on the schedule's ask reads nothing: checking for updates until the first check is due, then late", async () => {
    const { clock, checks, reads } = heldChecks();
    expect(await checks.releaseChannelHolds(SCHEDULE)).toEqual({
      pending: true,
      reason: "Checking for updates. This takes about two minutes after start.",
    });
    // A missed scheduled read: moving wall time runs no scheduled callbacks.
    clock.jump(FIRST_CHECK_MS + 10_000);
    expect(await checks.releaseChannelHolds(SCHEDULE)).toEqual({
      reason: "The first update check is late. Choose Check again.",
      details: [`First update check due at: ${at(FIRST_CHECK_MS)}`],
    });
    expect(reads()).toBe(0);
  });

  it("says a read that failed in plain words, what failed in details", async () => {
    const { checks, answer } = heldChecks();
    const answered = checks.releaseChannelHolds(CLIENT);
    await answer(unreachable);
    expect(await answered).toEqual({
      reason: "agent-harness could not check for updates. Check the internet connection, then choose Check again.",
      details: [`Update check: ${MANUAL_CLOCK_START}, unreachable`, unreachable.message],
    });
  });

  it("says the channel was not read in the last day once the last read is older, its time in details", async () => {
    const dataDir = tempDir("agent-harness-checks-");
    const kept = "2026-09-22T23:48:00.000Z";
    writeFileSync(join(dataDir, RELEASE_CHANNEL_FILE), `${JSON.stringify({ lastSucceededAt: kept })}\n`);
    const { clock, checks } = heldChecks(dataDir);
    clock.jump(RELEASE_CHANNEL_FRESH_MS);
    expect(await checks.releaseChannelHolds(SCHEDULE)).toEqual({
      reason: "agent-harness has not checked for updates in the last day. Choose Check again.",
      details: [`Last read of the release channel: ${kept}`],
    });
  });
});
