import { denylistPresets, type ContainmentReport, type EnvironmentLook } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import { readDenylist, readDenylistChangedBy } from "../permissions/denylist-store.js";
import { readPermissionsReport } from "../permissions/methods.js";
import { containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type StateCheckAnswer } from "../permissions/step-checks.js";
import type { Reader } from "../sessions/session-reads.js";
import type { StateCheckers } from "./check.js";

/**
 * How this environment answers every state check the step registry names
 * (#141): the Your machines step's not-root line, release channel (#346),
 * whether the machine is behind (#347) and, managed outside, the host-side
 * updater's poll (#348) and that the environment is named (#323), and the Permissions step's
 * three checks, each read when it runs.
 * Not-root and the containment default are read from what
 * `permissions.settings.get` answers (`readPermissionsReport`), the
 * denylist from its read model beside the presets for this environment's
 * data directory, the release channel from its checks (`updates/checks.ts`),
 * the updates from the update coordinator (`updates/coordinator.ts`), and
 * the host-side updater's poll from its record (`updates/host-updater.ts`).
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
  /** Whether auto-update is effective or the channel's newest runs, no update is past its cap or blocked, and no failed update left the machine behind (#347). */
  readonly updates: () => StateCheckAnswer;
  /** Whether updates are not managed outside, or the host-side updater polled in the last hour (#348). */
  readonly hostUpdater: () => StateCheckAnswer;
  /** The environment's name, icon and colour now (#323). */
  readonly look: () => EnvironmentLook;
}

export const environmentStateChecks = (options: StateChecksOptions): StateCheckers => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  const report = () => readPermissionsReport(reader, options.containment, options.isRoot);
  const presets = denylistPresets(options.dataDir);
  return {
    "your-machines.not-root": () => runsAsNonRoot(report().isRoot),
    "your-machines.release-channel": options.releaseChannel,
    "your-machines.updates": options.updates,
    "your-machines.host-updater": options.hostUpdater,
    // Named from the first start (ADR 0025's "named"): the record's name, the preset icon and colour stand until set.
    "your-machines.named": () => (options.look().name.trim() !== "" ? true : { reason: "The environment has no name: rename it." }),
    "permissions.containment": () => {
      const { values, containment } = report();
      return containmentDefaultHolds(values["permissions.containment.default"], containment);
    },
    "permissions.denylist": () => denylistHoldsPresets({ denylist: readDenylist(reader), changedBy: readDenylistChangedBy(reader) }, presets),
    "permissions.not-root": () => runsAsNonRoot(report().isRoot),
  };
};
