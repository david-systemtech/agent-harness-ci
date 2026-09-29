import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdateCheck, UpdateCheckFailure, UpdatesStatus } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { ChannelContext, ChannelReading, ChannelSettings, ReleaseChannelReader } from "./channel.js";

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
 * them. The Your machines step's `your-machines.release-channel` reads it:
 * it holds while auto-update is off (switched off, or a version pinned) or
 * a check succeeded in the last 24 hours. When the last one succeeded is
 * kept in the data directory (`RELEASE_CHANNEL_FILE`), so a restart, an
 * update's included, does not make the channel read as unread.
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
  /** The Your machines step's `your-machines.release-channel`. */
  releaseChannelHolds(): StateCheckAnswer;
  /** Schedules the first check and the hourly ones; returns the stop. Called once the wire is open. */
  start(): () => void;
}

/** The time of the last check that read the channel, as the data directory keeps it; none when it keeps none it can read. */
const readLastSucceeded = (path: string): number | undefined => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const at = Date.parse((JSON.parse(text) as { lastSucceededAt?: unknown }).lastSucceededAt as string);
    if (Number.isFinite(at)) return at;
  } catch {
    // Said below: a file that is not the record reads as none.
  }
  console.error(`${path} holds no time of a check of the release channel; it reads as none.`);
  return undefined;
};

/** Keeps `at` as the time of the last check that read the channel: a temporary file renamed over the record, so it is whole or the one before. */
const writeLastSucceeded = (path: string, at: number): void => {
  const temporary = `${path}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ lastSucceededAt: new Date(at).toISOString() })}\n`);
    renameSync(temporary, path);
  } catch (error) {
    console.error(`Keeping the time of the last check of the release channel in ${path} failed; the environment holds it until it stops:`, error);
  }
};

export const createChannelChecks = (options: ChannelChecksOptions): ChannelChecks => {
  const { clock, channel } = options;
  const recordPath = join(options.dataDir, RELEASE_CHANNEL_FILE);
  let status: ChannelStatus = { newest: null, lastCheck: null, target: null, passedOver: null };
  let lastSucceededAt = readLastSucceeded(recordPath);
  let lastStartedAt: number | undefined;
  let running: Promise<void> | undefined;
  /** Whether the settings changed while a check was under way, which read them before. */
  let again = false;
  let stopped = false;

  const once = async (): Promise<void> => {
    const at = clock.now();
    let lastCheck: UpdateCheck;
    try {
      const settings = options.settings();
      const read = await channel.read(settings, await options.context());
      if (read.outcome === "failed") {
        lastCheck = { at: at.toISOString(), result: "failed", reason: read.reason, message: read.message };
      } else {
        lastSucceededAt = at.getTime();
        writeLastSucceeded(recordPath, lastSucceededAt);
        status = { ...status, newest: read.newest, target: read.target, passedOver: read.passedOver };
        const unstaged = await options.follow(read, settings);
        lastCheck = unstaged === null ? { at: at.toISOString(), result: "ok" } : { at: at.toISOString(), result: "failed", ...unstaged };
      }
    } catch (error) {
      // A fault of the environment's own, such as a temporary file it could not write: the check failed, and says why.
      const message = error instanceof Error ? error.message : String(error);
      lastCheck = { at: at.toISOString(), result: "failed", reason: "unreachable", message: `The check failed: ${message}` };
    }
    status = { ...status, lastCheck };
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

    releaseChannelHolds() {
      const settings = options.settings();
      if (!settings.autoUpdate || settings.pinnedVersion !== null) return true;
      if (lastSucceededAt !== undefined && clock.now().getTime() - lastSucceededAt <= RELEASE_CHANNEL_FRESH_MS) return true;
      const last = status.lastCheck;
      const since = lastSucceededAt === undefined ? "yet" : "in the last 24 hours";
      if (last === null) return { reason: `The release channel has not been read ${since}: the environment reads it two minutes after it starts, then hourly.` };
      return { reason: `The release channel has not been read ${since}: ${last.result === "failed" ? last.message : "no check succeeded."}` };
    },

    start() {
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
