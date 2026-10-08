import type { ForgeAccountMissingError, ForgeAccountRecord, ForgeOrigin } from "@agent-harness/contracts";
import type { EventLog, StreamRef } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-tables.js";
import { missingOrigins, type MissingOrigin } from "./forge-store.js";
import { neededElsewhere, siteOf } from "./lines.js";
import { servedOrigins } from "./git-helper.js";
import { FORGE_ACTOR } from "./verifier.js";

/**
 * Missing origins (forge spec, "No forge account"; ADR 0020): an origin a
 * harness operation was refused on for want of a forge account. It is
 * recorded as `forge.origin-missing`, as `system:forge`, at most once a day
 * per origin, and counts, for the Forges step's coverage check (#319), for
 * seven days after its last record, until a forge account covers it (chosen
 * defaults; a day and a week are rolling, from the last record).
 */

/** The refusal of a harness operation on `origin`, which no forge account covers, for the reason `why`: naming the site plainly, `why` in details and the Forges step in data. */
export const forgeAccountMissing = (origin: ForgeOrigin, why: string): ForgeAccountMissingError => ({
  code: "forge_account_missing",
  message: neededElsewhere(siteOf(origin)),
  data: { origin, step: "forges", details: [`${origin}: ${why}`] },
});

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
  /** Records that `operation` was refused on `origin`, unless the origin was recorded within the day. */
  record(origin: ForgeOrigin, operation: string): void;
  /** The missing origins that count now: recorded within seven days, and served by no forge account. */
  counted(): MissingOrigin[];
}

export const createMissingOrigins = ({ log, clock, stream, reader, accounts }: MissingOriginsOptions): MissingOrigins => ({
  record(origin, operation) {
    // Read and appended in one transaction, so two refusals at once record one.
    log.atomically((tx) => {
      const last = missingOrigins(reader).find((missing) => missing.origin === origin);
      if (last !== undefined && clock.now().getTime() - Date.parse(last.recordedAt) < MISSING_ORIGIN_RECORD_MS) return;
      log.append(stream, [{ type: "forge.origin-missing", payload: { origin, operation } }], { tx, actor: FORGE_ACTOR });
    });
  },
  counted() {
    const covered = new Set(accounts().flatMap(servedOrigins));
    const now = clock.now().getTime();
    return missingOrigins(reader).filter((missing) => !covered.has(missing.origin) && now - Date.parse(missing.recordedAt) < MISSING_ORIGIN_COUNTS_MS);
  },
});
