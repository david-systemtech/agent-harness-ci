import { join } from "node:path";
import { utcMinute } from "../instructions/orientation.js";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock } from "../serve/clock.js";
import { readKeptTime, writeKeptTime } from "./kept-time.js";

/**
 * The host-side updater's polls (launcher-update spec, "Containers: the
 * host-side updater" and "Settings, methods, notices and flags"; #348).
 * Every five minutes the updater runs `update status --json --host-updater`
 * in the container, whose `updates.status` with `hostUpdater: true` is its
 * poll. The environment remembers the last one, in the data directory
 * (`HOST_UPDATER_FILE`), so the container's recreate, an update's, does not
 * read as never polled: the manager reads `outside` with its time, the
 * `self-update` flag is present while one came in the last fifteen minutes,
 * and the Your machines step's `your-machines.host-updater` holds while one
 * came in the last hour. Only an environment whose updates are managed
 * outside (a container with no launcher) remembers a poll or needs one.
 */

/** Where the time of the host-side updater's last poll is kept, in the data directory. */
export const HOST_UPDATER_FILE = "host-updater.json";

const MINUTE_MS = 60_000;

/** How recent a poll keeps the `self-update` flag present managed outside: the updater polls every five minutes, so three polls missed. */
export const SELF_UPDATE_POLL_MS = 15 * MINUTE_MS;

/** How recent a poll keeps the Your machines step's host-updater check holding. */
export const HOST_UPDATER_FRESH_MS = 60 * MINUTE_MS;

/** The field of `HOST_UPDATER_FILE` holding the time, and that time for people. */
const LAST_POLL = "lastPollAt";
const WHAT = "the host-side updater's last poll";

export interface HostUpdaterPollsOptions {
  readonly clock: Clock;
  /** The data directory, where the time of the last poll is kept. */
  readonly dataDir: string;
  /** Whether the environment's updates are managed outside: only then is a poll remembered, or needed. */
  readonly managedOutside: boolean;
}

export interface HostUpdaterPolls {
  /** `updates.status` with `hostUpdater: true`: the updater polled now. */
  polled(): void;
  /** When it last polled, as the manager `outside` reads it; null before its first poll. */
  lastPoll(): string | null;
  /** Whether it polled in the last fifteen minutes: managed outside, the `self-update` flag's rule. */
  selfUpdate(): boolean;
  /** The Your machines step's `your-machines.host-updater`: not managed outside, or a poll in the last hour. */
  holds(): StateCheckAnswer;
}

export const createHostUpdaterPolls = (options: HostUpdaterPollsOptions): HostUpdaterPolls => {
  const { clock, managedOutside } = options;
  const path = join(options.dataDir, HOST_UPDATER_FILE);
  let lastPollAt = managedOutside ? readKeptTime(path, LAST_POLL, WHAT) : undefined;

  /** Whether a poll came within `ms` of now. */
  const within = (ms: number): boolean => lastPollAt !== undefined && clock.now().getTime() - lastPollAt <= ms;

  return {
    polled() {
      if (!managedOutside) return;
      lastPollAt = clock.now().getTime();
      writeKeptTime(path, LAST_POLL, lastPollAt, WHAT);
    },

    lastPoll: () => (lastPollAt === undefined ? null : new Date(lastPollAt).toISOString()),

    selfUpdate: () => managedOutside && within(SELF_UPDATE_POLL_MS),

    holds() {
      if (!managedOutside || within(HOST_UPDATER_FRESH_MS)) return true;
      // setup-copy.md §5.4's lines (#1848).
      if (lastPollAt === undefined) {
        return { reason: "This container is not kept up to date yet. Set up the updater on the host computer.", actions: ["how-to-set-up", "check-again"] };
      }
      // The poll's time as data, which a client words where it is; the reason's own words for it stand for one that does not (#1742).
      const at = new Date(lastPollAt).toISOString();
      const when = `more than an hour ago, at ${utcMinute(at)}`;
      return {
        reason: `The host's updater last ran ${when}. Check that it still runs every five minutes.`,
        details: [`Host updater's last poll: ${at}`],
        times: [{ text: when, at }],
        // It has polled, so it is set up: no How to set it up (#1883).
        actions: ["check-again"],
      };
    },
  };
};
