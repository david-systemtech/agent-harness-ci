import { describe, expect, it } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { manualClock, MANUAL_CLOCK_START } from "../../test/clock.js";
import type { ChannelFailure, ChannelReading, ReleaseChannelReader } from "./channel.js";
import { createChannelChecks } from "./checks.js";

/**
 * The channel's checks against a read held until the test lets it answer,
 * beside Update now's read of the channel (#1774): what `updates.status`
 * shows of the channel is what the read that began last found.
 */

const { tempDir } = useCleanups();

/** What a read finds with `newest` the channel's newest, nothing to target. */
const reading = (newest: string): ChannelReading => ({ outcome: "read", newest, target: null, passedOver: null, stage: null, blocked: null });

/** Checks whose every read waits for the answer the test gives it. */
const heldChecks = () => {
  const clock = manualClock();
  const answers: ((read: ChannelReading | ChannelFailure) => void)[] = [];
  const channel: ReleaseChannelReader["read"] = () => new Promise((resolve) => answers.push(resolve));
  const checks = createChannelChecks({
    clock,
    dataDir: tempDir("agent-harness-checks-"),
    channel: { read: channel } as ReleaseChannelReader,
    settings: () => ({ autoUpdate: true, channel: "stable", pinnedVersion: null }),
    context: () => Promise.resolve({ launcherProtocol: null, failedVersions: [] }),
    follow: () => Promise.resolve(null),
  });
  /** Lets the read under way answer, once it has begun. */
  const answer = async (read: ChannelReading | ChannelFailure): Promise<void> => {
    await expect.poll(() => answers.length).toBe(1);
    answers.shift()?.(read);
  };
  return { clock, checks, answer };
};

const SECOND_LATER = new Date(Date.parse(MANUAL_CLOCK_START) + 1000);

describe("Update now's read of the channel", () => {
  it("is shown as a check that found what it found, and a check that began before it and ends after it does not replace it", async () => {
    const { clock, checks, answer } = heldChecks();
    const checking = checks.check();
    clock.advance(1000);
    checks.readByRequest(reading("0.5.0"), clock.now());
    expect(checks.status()).toEqual({ newest: "0.5.0", lastCheck: { at: SECOND_LATER.toISOString(), result: "ok" }, target: null, passedOver: null });

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
      target: null,
      passedOver: null,
    });
  });
});
