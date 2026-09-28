import { denylistPresets, type ContainmentReport } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { readDenylist, readDenylistChangedBy } from "../permissions/denylist-store.js";
import { readPermissionsReport } from "../permissions/methods.js";
import { containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type StateCheckAnswer } from "../permissions/step-checks.js";
import type { Reader } from "../sessions/session-reads.js";
import type { StateCheckers } from "./check.js";

/**
 * How this environment answers every state check the step registry names
 * (#141): the Your machines step's not-root line and release channel
 * (#346), and the Permissions step's three checks, each read when it runs.
 * Not-root and the containment default are read from what
 * `permissions.settings.get` answers (`readPermissionsReport`), the
 * denylist from its read model beside the presets for this environment's
 * data directory, the release channel from its checks (`updates/checks.ts`).
 */

export interface StateChecksOptions {
  readonly log: EventLog;
  /** What containment can enforce here, as the start's probe found it (#133). */
  readonly containment: ContainmentReport;
  /** Whether the environment runs as root: what `permissions.settings.get` answers. */
  readonly isRoot: boolean;
  /** The data directory, absolute: the denylist's presets name it (#132). */
  readonly dataDir: string;
  /** Whether auto-update is off or the release channel was read in the last 24 hours (#346). */
  readonly releaseChannel: () => StateCheckAnswer;
}

export const environmentStateChecks = (options: StateChecksOptions): StateCheckers => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  const report = () => readPermissionsReport(reader, options.containment, options.isRoot);
  const presets = denylistPresets(options.dataDir);
  return {
    "your-machines.not-root": () => runsAsNonRoot(report().isRoot),
    "your-machines.release-channel": options.releaseChannel,
    "permissions.containment": () => {
      const { values, containment } = report();
      return containmentDefaultHolds(values["permissions.containment.default"], containment);
    },
    "permissions.denylist": () => denylistHoldsPresets({ denylist: readDenylist(reader), changedBy: readDenylistChangedBy(reader) }, presets),
    "permissions.not-root": () => runsAsNonRoot(report().isRoot),
  };
};
