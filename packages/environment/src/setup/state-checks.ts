import { denylistPresets, type ContainmentReport } from "@agent-harness/contracts";
import { themeMeetsRules } from "../appearance/contrast.js";
import type { EventLog } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import { forgesStateChecks } from "../forge/step-checks.js";
import { readDenylist, readDenylistChangedBy } from "../permissions/denylist-store.js";
import { readPermissionsReport } from "../permissions/methods.js";
import { containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import type { StateCheckers } from "./check.js";

/**
 * How this environment answers every state check the step registry names
 * (#141): the Your machines step's not-root line, release channel (#346),
 * whether the machine is behind (#347) and, managed outside, the host-side
 * updater's poll (#348), the Forges step's seven (#319), the Permissions
 * step's three checks, and the Appearance step's contrast (#391), each read
 * when it runs.
 * Not-root and the containment default are read from what
 * `permissions.settings.get` answers (`readPermissionsReport`), the
 * denylist from its read model beside the presets for this environment's
 * data directory, the release channel from its checks (`updates/checks.ts`),
 * the updates from the update coordinator (`updates/coordinator.ts`), the
 * host-side updater's poll from its record (`updates/host-updater.ts`), the
 * forge accounts from the ForgeService (`forge/step-checks.ts`), and the
 * theme from the settings, derived by the theme package
 * (`appearance/contrast.ts`).
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
  /** The ForgeService, whose forge accounts the Forges step checks. */
  readonly forge: ForgeService;
  /** The environment's clock: a forge token's expiry is read against it. */
  readonly clock: Clock;
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
    ...forgesStateChecks({ forge: options.forge, clock: options.clock }),
    "permissions.containment": () => {
      const { values, containment } = report();
      return containmentDefaultHolds(values["permissions.containment.default"], containment);
    },
    "permissions.denylist": () => denylistHoldsPresets({ denylist: readDenylist(reader), changedBy: readDenylistChangedBy(reader) }, presets),
    "permissions.not-root": () => runsAsNonRoot(report().isRoot),
    "appearance.contrast": () => themeMeetsRules(readSettings(reader)["appearance.theme"]),
  };
};
