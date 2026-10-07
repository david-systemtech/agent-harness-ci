import { join } from "node:path";
import { CHECK_BUDGET_SECONDS, type UpdateCheck, type UpdateCheckFailure, type UpdatesStatus } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { ChannelContext, ChannelFailure, ChannelReading, ChannelSettings, ReleaseChannelReader } from "./channel.js";
import { readKeptTime, writeKeptTime } from "./kept-time.js";

/**
 * The checks of the release channel (launcher-update spec, "Reading the
 * channel"; #346): the first two minutes after the environment starts, then
 * hourly; on `updates.check`, at most once a minute, a repeat within a
 * minute of the last check's start answering that check's result without
 * reading the forge; and once the update settings the target follows
 * change. A check that reads the channel hands what it found to the update
 * coordinator, which stages it (#347), and the check fails as its staging
 * does. A failed check is state, never a notice: `updates.status` shows
 * the last check with its reason, and the channel's newest, the target and
 * a release passed over as the last check that read the channel found
 * them. Update now's read of the channel (`updates.apply`) is shown as a
 * check's, staging nothing of its own, so the newest it resolved the update
 * against is the newest shown (#1774); a read never replaces what one that
 * began after it found. The Your machines step's
 * `your-machines.release-channel` reads it: it holds while auto-update is
 * off (switched off, or a version pinned) or a check succeeded in the last
 * 24 hours. Before its first scheduled read,
 * it reports pending through the startup delay and network budget (#1326),
 * then needs attention if no read completed. When the last one succeeded is
 * kept in the data directory (`RELEASE_CHANNEL_FILE`), so a restart, an
 * update's included, does not make the channel read as unread. A check
 * appends nothing, so no trigger the step names hears it: the environment
 * hears each check that ends through `onChecked` instead, and triggers the
 * step from it (#679).
 */

/** Where the time of the last check that read the channel is kept, in the data directory. */
export const RELEASE_CHANNEL_FILE = "release-channel.json";

const MINUTE_MS = 60_000;

/** When the first check runs after the start. */
export const FIRST_CHECK_MS = 2 * MINUTE_MS;

/** How often a check runs after the first. */
export const CHECK_INTERVAL_MS = 60 * MINUTE_MS;

/** How long after a check's start `updates.check` answers its result instead of reading the forge again. */
export const CHECK_AGAIN_MS = MINUTE_MS;

/** How long a successful check keeps the release channel's Set up check holding. */
export const RELEASE_CHANNEL_FRESH_MS = 24 * 60 * MINUTE_MS;

/** What `updates.status` shows of the channel. */
export type ChannelStatus = Pick<UpdatesStatus, "newest" | "lastCheck" | "target" | "passedOver">;

/** Why the staging of what a check found failed: the check's reason, and what failed. */
export interface StagingFailure {
  readonly reason: UpdateCheckFailure;
  readonly message: string;
}

export interface ChannelChecksOptions {
  readonly clock: Clock;
  /** The data directory, where the time of the last check that read the channel is kept. */
  readonly dataDir: string;
  readonly channel: ReleaseChannelReader;
  /** The update settings as they are now, read at each check's start. */
  readonly settings: () => ChannelSettings;
  /** What the channel is read with beside the settings, read at each check's start. */
  readonly context: () => Promise<ChannelContext>;
  /** Stages what a check that read the channel under `settings` found: null once staged or when there is nothing to stage, else why not. */
  readonly follow: (reading: ChannelReading, settings: ChannelSettings) => Promise<StagingFailure | null>;
}

export interface ChannelChecks {
  /** The channel's newest, the last check, the target and a release passed over. */
  status(): ChannelStatus;
  /** `updates.check`: a check now, or the one under way; within a minute of the last check's start, nothing: that check's result stands. */
  check(): Promise<void>;
  /** The settings the target follows changed: a check now, or again once the one under way ends. */
  settingsChanged(): void;
  /** Update now's read of the channel (`updates.apply`), which began `at`: shown as a check that found `read`, staging nothing. */
  readByRequest(read: ChannelReading | ChannelFailure, at: Date): void;
  /** The Your machines step's `your-machines.release-channel`. */
  releaseChannelHolds(): StateCheckAnswer;
  /**
   * Hears each check as it ends, whether it read the channel or failed: what
   * `releaseChannelHolds` answers and the channel's newest may have changed,
   * and no event says so. Returns the unsubscribe.
   */
  onChecked(listener: () => void): () => void;
  /** Schedules the first check and the hourly ones; returns the stop. Called once the wire is open. */
  start(): () => void;
}

/** The field of `RELEASE_CHANNEL_FILE` holding the time of the last check that read the channel, and that time for people. */
const LAST_SUCCEEDED = "lastSucceededAt";
const LAST_CHECK = "the last check of the release channel";

export const createChannelChecks = (options: ChannelChecksOptions): ChannelChecks => {
  const { clock, channel } = options;
  const recordPath = join(options.dataDir, RELEASE_CHANNEL_FILE);
  let status: ChannelStatus = { newest: null, lastCheck: null, target: null, passedOver: null };
  let lastSucceededAt = readKeptTime(recordPath, LAST_SUCCEEDED, LAST_CHECK);
  let lastStartedAt: number | undefined;
  /** When the read whose findings `status` shows began: a read that began before it shows nothing. */
  let shownAt = Number.NEGATIVE_INFINITY;
  let firstCheckDueAt = clock.now().getTime() + FIRST_CHECK_MS;
  let running: Promise<void> | undefined;
  /** Whether the settings changed while a check was under way, which read them before. */
  let again = false;
  let stopped = false;
  const listeners = new Set<() => void>();

  /** The failed check of a read that began `at`. */
  const failedCheck = (at: Date, failure: { readonly reason: UpdateCheckFailure; readonly message: string }): UpdateCheck => ({ at: at.toISOString(), result: "failed", reason: failure.reason, message: failure.message });

  /** The failed check of a read that began `at` and met a fault of the environment's own, such as a file it could not write. */
  const faultCheck = (at: Date, error: unknown): UpdateCheck =>
    failedCheck(at, { reason: "unreachable", message: `The check failed: ${error instanceof Error ? error.message : String(error)}` });

  /** A read that began `at` found `reading`: its time kept, and its newest, target and release passed over shown unless a later read's are. */
  const found = (at: Date, reading: ChannelReading): void => {
    if (lastSucceededAt === undefined || at.getTime() > lastSucceededAt) {
      lastSucceededAt = at.getTime();
      writeKeptTime(recordPath, LAST_SUCCEEDED, lastSucceededAt, LAST_CHECK);
    }
    if (at.getTime() < shownAt) return;
    shownAt = at.getTime();
    status = { ...status, newest: reading.newest, target: reading.target, passedOver: reading.passedOver };
  };

  /** A read that began `at` ended as `lastCheck`, shown unless a later read's is; then the listeners hear it. */
  const ended = (at: Date, lastCheck: UpdateCheck): void => {
    if (at.getTime() >= shownAt) {
      shownAt = at.getTime();
      status = { ...status, lastCheck };
    }
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("A listener to the release channel's checks threw:", error);
      }
    }
  };

  const once = async (): Promise<void> => {
    const at = clock.now();
    let lastCheck: UpdateCheck;
    try {
      const settings = options.settings();
      const read = await channel.read(settings, await options.context());
      if (read.outcome === "failed") {
        lastCheck = failedCheck(at, read);
      } else {
        found(at, read);
        const unstaged = await options.follow(read, settings);
        lastCheck = unstaged === null ? { at: at.toISOString(), result: "ok" } : failedCheck(at, unstaged);
      }
    } catch (error) {
      lastCheck = faultCheck(at, error);
    }
    ended(at, lastCheck);
  };

  /** Runs a check, or answers the one under way. */
  const run = (): Promise<void> => {
    if (running !== undefined) return running;
    lastStartedAt = clock.now().getTime();
    running = once().finally(() => {
      running = undefined;
      if (again && !stopped) {
        again = false;
        void run();
      }
    });
    return running;
  };

  return {
    status: () => status,

    check() {
      if (running !== undefined) return running;
      if (lastStartedAt !== undefined && clock.now().getTime() - lastStartedAt < CHECK_AGAIN_MS) return Promise.resolve();
      return run();
    },

    settingsChanged() {
      if (stopped) return;
      if (running !== undefined) again = true;
      else void run();
    },

    readByRequest(read, at) {
      if (read.outcome === "failed") return ended(at, failedCheck(at, read));
      try {
        found(at, read);
      } catch (error) {
        return ended(at, faultCheck(at, error));
      }
      ended(at, { at: at.toISOString(), result: "ok" });
    },

    releaseChannelHolds() {
      const settings = options.settings();
      if (!settings.autoUpdate || settings.pinnedVersion !== null) return true;
      if (lastSucceededAt !== undefined && clock.now().getTime() - lastSucceededAt <= RELEASE_CHANNEL_FRESH_MS) return true;
      const last = status.lastCheck;
      if (lastSucceededAt === undefined && last === null && clock.now().getTime() < firstCheckDueAt + CHECK_BUDGET_SECONDS.network * 1000) {
        return { pending: true, reason: "Waiting for the first release channel read, scheduled two minutes after the environment starts." };
      }
      if (lastSucceededAt === undefined && last === null) {
        return { reason: "The first scheduled release channel read is overdue: it has not completed within ten seconds of its scheduled time." };
      }
      const since = lastSucceededAt === undefined ? "yet" : "in the last 24 hours";
      if (last === null) return { reason: `The release channel has not been read ${since}: the environment reads it two minutes after it starts, then hourly.` };
      return { reason: `The release channel has not been read ${since}: ${last.result === "failed" ? last.message : "no check succeeded."}` };
    },

    onChecked(listener) {
      const own = () => listener();
      listeners.add(own);
      return () => void listeners.delete(own);
    },

    start() {
      firstCheckDueAt = clock.now().getTime() + FIRST_CHECK_MS;
      let hourly: Timer | undefined;
      const first = clock.setTimeout(() => {
        hourly = clock.setInterval(() => void run(), CHECK_INTERVAL_MS);
        void run();
      }, FIRST_CHECK_MS);
      return () => {
        stopped = true;
        first.cancel();
        hourly?.cancel();
      };
    },
  };
};
