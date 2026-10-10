import type { ForgeAccountMissingError, ForgeAccountRecord, ForgeOrigin } from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import { missingOn, missingOrigins, type MissingOrigin } from "./forge-store.js";
import { neededElsewhere, siteOf } from "./lines.js";
import { servedOrigins } from "./git-helper.js";
import { FORGE_ACTOR } from "./verifier.js";

/**
 * Missing origins (forge spec, "No forge account"; ADR 0020): an origin a
 * harness operation was refused on for want of a forge account. It is
 * recorded as `forge.origin-missing`, as `system:forge`, at most once a day
 * per origin, and counts, for the Forges step's coverage check (#319), for
 * seven days after its last record, until a forge account covers it (chosen
 * defaults; a day and a week are rolling, from the last record), or until
 * the operation its last record names reads the repository it names
 * anonymously after all, recorded as `forge.origin-answered` (#1891): a
 * public repository the forge refused once in passing needs no forge
 * account. Another repository read under the same operation clears nothing:
 * an operation names a kind of work (`sync a memory bank`), which a private
 * and a public repository on one origin can share. A record naming no
 * repository is never answered.
 */

/** The refusal of a harness operation on `origin`, which no forge account covers, for the reason `why`: naming the site plainly, `why` in details and the Forges step in data. */
export const forgeAccountMissing = (origin: ForgeOrigin, why: string): ForgeAccountMissingError => ({
  code: "forge_account_missing",
  message: neededElsewhere(siteOf(origin)),
  data: { origin, step: "forges", details: [`${origin}: ${why}`] },
});

/** How that refusal's message on `origin` began before #1850 reworded it, which a failed landing stored then still carries. */
const earlierOpening = (origin: ForgeOrigin): string => `No forge account on this environment covers ${origin}, and `;

/** Whether `message` is that refusal's on `origin`, in its wording now or before #1850: a record that kept only the message, as a failed landing's reason does, still names its cause (#1900). */
export const isForgeAccountMissingOn = (message: string, origin: ForgeOrigin): boolean =>
  message.startsWith(neededElsewhere(siteOf(origin))) || message.startsWith(earlierOpening(origin));

/** Whether a forge account among `accounts` serves `origin`, at its own origin or a verified alias. */
export const coversOrigin = (accounts: readonly Pick<ForgeAccountRecord, "origin" | "aliases">[], origin: ForgeOrigin): boolean =>
  accounts.some((account) => servedOrigins(account).includes(origin));

/** How long after an origin's last record another refusal there records nothing. */
export const MISSING_ORIGIN_RECORD_MS = 24 * 60 * 60_000;

/** How long an origin's last record counts. */
export const MISSING_ORIGIN_COUNTS_MS = 7 * 24 * 60 * 60_000;

export interface MissingOriginsOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  readonly stream: StreamRef;
  readonly reader: Reader;
  /** The forge accounts the environment holds now. */
  readonly accounts: () => readonly ForgeAccountRecord[];
}

export interface MissingOrigins {
  /** Records that `operation` was refused on `origin`, on `repository` where it names one, unless the origin was recorded within the day. */
  record(origin: ForgeOrigin, operation: string, repository?: string): void;
  /** Clears the origin's record when its last one names `operation` on `repository`, which the origin has now answered anonymously; a no-op otherwise. */
  answered(origin: ForgeOrigin, operation: string, repository: string): void;
  /** The missing origins that count now: recorded within seven days, and served by no forge account. */
  counted(): MissingOrigin[];
  /** Stops hearing operation completions before the environment closes the log. */
  close(): void;
}

export const createMissingOrigins = ({ log, clock, stream, reader, accounts }: MissingOriginsOptions): MissingOrigins => {
  // A download or git read may finish after ForgeService closes, and the event log with it.
  let closed = false;
  return {
    record(origin, operation, repository) {
      if (closed) return;
      // Read and appended in one transaction, so two refusals at once record one.
      log.atomically((tx) => {
        const last = missingOrigins(reader).find((missing) => missing.origin === origin);
        if (last !== undefined && clock.now().getTime() - Date.parse(last.recordedAt) < MISSING_ORIGIN_RECORD_MS) return;
        log.append(stream, [{ type: "forge.origin-missing", payload: { origin, operation, ...(repository !== undefined && { repository }) } }], { tx, actor: FORGE_ACTOR });
      });
    },
    answered(origin, operation, repository) {
      if (closed) return;
      const recorded = (): boolean => missingOn(reader, origin, operation, repository);
      // Nearly every anonymous read finds no record, and takes no transaction; one that does is checked again in it.
      if (!recorded()) return;
      log.atomically((tx) => {
        if (recorded()) log.append(stream, [{ type: "forge.origin-answered", payload: { origin, operation, repository } }], { tx, actor: FORGE_ACTOR });
      });
    },
    counted() {
      const held = accounts();
      const now = clock.now().getTime();
      return missingOrigins(reader).filter((missing) => !coversOrigin(held, missing.origin) && now - Date.parse(missing.recordedAt) < MISSING_ORIGIN_COUNTS_MS);
    },
    close() {
      closed = true;
    },
  };
};
