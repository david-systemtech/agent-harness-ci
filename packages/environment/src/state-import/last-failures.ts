import { ENVIRONMENT_STREAM_KIND, StateImportFinishedPayload, type StateImportFailure } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";

/** The last completed import's failures for a new subscriber, including after the log is reopened. */
export const lastImportFailures = (log: EventLog, environmentId: string): StateImportFailure[] => {
  const [row] = log.read<{ payload: string }>(
    "SELECT payload FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'state-import.finished' ORDER BY sequence DESC LIMIT 1",
    ENVIRONMENT_STREAM_KIND,
    environmentId,
  );
  return row === undefined ? [] : StateImportFinishedPayload.parse(JSON.parse(row.payload)).failed;
};
