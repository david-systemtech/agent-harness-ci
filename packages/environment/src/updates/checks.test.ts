import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChannelCheckedPayload } from "@agent-harness/contracts";
import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock, MANUAL_CLOCK_START } from "../../test/clock.js";
import type { ChannelFailure, ChannelReading, ReleaseChannelReader } from "./channel.js";
import { CHECK_AGAIN_MS, RELEASE_CHANNEL_FILE, createChannelChecks } from "./checks.js";

/**
 * The channel's checks against a read held until the test lets it answer,
 * beside Update now's read of the channel (#1774): what `updates.status`
 * shows of the channel is what the read that began last found. A check that
 * changes what it shows is said on the environment's stream (#1795).
 */

const { tempDir } = useCleanups();

/** What a read finds with `newest` the channel's newest, nothing to target. */
const reading = (newest: string): ChannelReading => ({ outcome: "read", newest, target: null, passedOver: null, stage: null, blocked: null });

/** Checks over `dataDir` whose every read waits for the answer the test gives it. */
const heldChecks = (dataDir = tempDir("agent-harness-checks-")) => {
  const clock = manualClock();
  const answers: ((read: ChannelReading | ChannelFailure) => void)[] = [];
  const said: ChannelCheckedPayload[] = [];
  const channel: ReleaseChannelReader["read"] = () => new Promise((resolve) => answers.push(resolve));
  const checks = createChannelChecks({
    clock,
    dataDir,
    channel: { read: channel } as ReleaseChannelReader,
    settings: () => ({ autoUpdate: true, channel: "stable", pinnedVersion: null }),
    context: () => Promise.resolve({ launcherProtocol: null, failedVersions: [] }),
    follow: () => Promise.resolve(null),
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
  return { clock, checks, answer, checked, said };
};

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
    expect(checks.releaseChannelHolds()).toBe(true);
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
