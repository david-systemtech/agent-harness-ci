import { DRAIN_CAP_MS, denylistPresets, type AccountRecord, type ContainmentReport, type EnvironmentLook, type EnvironmentStatus, type SettingsValues, type StateImportDetection } from "@agent-harness/contracts";
import { accountStateChecks } from "../accounts/step-checks.js";
import type { AdapterRegistry } from "../adapter/registry.js";
import { themeMeetsRules } from "../appearance/contrast.js";
import type { BankRecords } from "../banks/records.js";
import { memoryBankStateChecks } from "../banks/step-checks.js";
import type { BrowserService } from "../browser/service.js";
import { carryOverDoneLine, carryOverStateChecks, type CarryOverStateChecksOptions } from "../carry-over/step-checks.js";
import { instructionsStateChecks } from "../instructions/step-checks.js";
import type { OrientationAnswer } from "../instructions/composer.js";
import type { EventLog } from "../event-log/event-log.js";
import type { ForgeService } from "../forge/forge-service.js";
import { forgesStateChecks } from "../forge/step-checks.js";
import { readableMinute } from "../forge/verification.js";
import type { KeyManagerConnections } from "../key-managers/connections.js";
import { keyManagerStateChecks } from "../key-managers/step-checks.js";
import type { ManagedTools } from "../managed-tools/registry.js";
import { readDenylist, readDenylistChangedBy } from "../permissions/denylist-store.js";
import { readPermissionsReport } from "../permissions/methods.js";
import { containmentDefaultHolds, denylistHoldsPresets, runsAsNonRoot, type StateCheckAnswer } from "../permissions/step-checks.js";
import type { Clock } from "../serve/clock.js";
import { lanAddressHeld } from "../serve/interfaces.js";
import type { Reader } from "../sessions/session-reads.js";
import { readSettings } from "../settings/settings-store.js";
import { skillsStateChecks, type SkillsStateChecksOptions } from "../skills/step-checks.js";
import type { DoneLines, StateCheckers } from "./check.js";

/**
 * How this environment answers every state check the step registry names
 * (#141): the Account step's two, from the account store (#574), the Carry
 * over step's three (#581), the Your machines step's not-root line, release
 * channel (#346),
 * whether the machine is behind (#347) and, managed outside, the host-side
 * updater's poll (#348), that the environment is named (#323) and ready,
 * not draining past its cap (#574), and that its LAN address is one the
 * machine holds (#773), the Forges step's seven (#319), the Key
 * manager step's skip check (#367) and four others (#383), the Memory bank
 * step's six (#586), the Browser step's three (#559), the Permissions
 * step's three checks, the Skills step's local reads and state-derived skip
 * and the Instructions step's orientation read (#514), and the Appearance step's contrast (#391), each read
 * when it runs.
 * Not-root and the containment default are read from what
 * `permissions.settings.get` answers (`readPermissionsReport`), the
 * accounts from the account store (`accounts/step-checks.ts`), readiness
 * from the lifecycle's status document on the environment's clock, the LAN
 * address from the settings beside the machine's interfaces now, the
 * denylist from its read model beside the presets for this environment's
 * data directory, the adopted accounts' directories, their listings, the
 * imports the log records and the state import's detection
 * (`carry-over/step-checks.ts`), the release channel from its checks (`updates/checks.ts`),
 * the updates from the update coordinator (`updates/coordinator.ts`), the
 * host-side updater's poll from its record (`updates/host-updater.ts`), the
 * forge accounts from the ForgeService (`forge/step-checks.ts`), the
 * key-manager connections from their store and their verification, and
 * their CLIs from the Managed tools rows (`key-managers/step-checks.ts`),
 * the banks from their records and their verification
 * (`banks/step-checks.ts`), the paired Chromes from the chrome projection
 * and their live connections and shipped version from the browser service,
 * and the theme from the settings, derived by the theme package
 * (`appearance/contrast.ts`).
 */

export interface StateChecksOptions {
  readonly log: EventLog;
  /** Source standings, the own directory and the clock, all read locally. */
  readonly skills: SkillsStateChecksOptions;
  /** The same preview the Instructions row reads, null without an account. */
  readonly orientation: () => Promise<OrientationAnswer | null>;
  /** The adapters, by provider: an adopted account's lists its directory's sessions. */
  readonly adapters: Pick<AdapterRegistry, "get">;
  /** Whether a source data folder or terminal-client state folder is on this machine (`stateImport.detect`). */
  readonly detectStateImport: () => Promise<StateImportDetection>;
  /** The state import's, for Carry over's last import: the environment's id and the import under way. */
  readonly stateImport: CarryOverStateChecksOptions["stateImport"];
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
  /** The accounts the account store holds now, each with its latest status (#134): the Account step checks them, and Carry over reads the adopted ones' directories. */
  readonly accounts: () => readonly AccountRecord[];
  /** The environment's status document now: its readiness, and since when it drains (`lifecycle.ts`). */
  readonly status: () => EnvironmentStatus;
  /** The LAN addresses the machine holds now, the interface detector's: what `network.bindLan` may name (#574). */
  readonly lanAddresses: () => readonly string[];
  /** The ForgeService, whose forge accounts the Forges step checks. */
  readonly forge: ForgeService;
  /** The key-manager connections, which the Key manager step checks, verifying every one. */
  readonly keyManagerConnections: Pick<KeyManagerConnections, "list" | "verify">;
  /** The Managed tools registry, whose rows say whether an injecting connection's CLI is installed. */
  readonly managedTools: Pick<ManagedTools, "list">;
  /** The banks the environment registers, which the Memory bank step checks, verifying every one. */
  readonly banks: BankRecords;
  /** The browser service, whose checks read its listener and the paired Chromes. */
  readonly browser: Pick<BrowserService, "stateChecks">;
  /** The environment's clock: a forge token's expiry is read against it. */
  readonly clock: Clock;
  /** The version the environment runs: Your machines' line when done names it. */
  readonly version: string;
}

/**
 * The environment is ready, or draining no longer than its cap (ADR 0025:
 * needs attention when draining past its cap): a drain within it is an
 * update or a restart under way.
 */
const readyWithinCap = ({ readiness, activity }: EnvironmentStatus, now: Date): StateCheckAnswer => {
  if (activity.state === "draining") {
    if (now.getTime() - Date.parse(activity.drainingSince) <= DRAIN_CAP_MS) return true;
    return {
      reason: `The environment has been draining since ${readableMinute(activity.drainingSince)}, past its ${DRAIN_CAP_MS / 60_000}-minute cap: Check again once it has restarted.`,
    };
  }
  return readiness === "ready" || { reason: "The environment is still starting: Check again once it is ready." };
};

/**
 * Your machines' line when done (#1698): ready, or draining within its cap,
 * on the version it runs; whether updates are on, off, pinned or the host's;
 * and where it can be reached beside this machine.
 */
export const yourMachinesLine = (version: string, { activity, updatesManagedOutside, binding }: EnvironmentStatus, values: SettingsValues): string => {
  const pinned = values["updates.pinnedVersion"];
  const updates = updatesManagedOutside
    ? "updates by the host"
    : !values["updates.autoUpdate"]
      ? "updates off"
      : pinned !== null
        ? `updates pinned to ${pinned}`
        : "updates on";
  const networks = [...(binding?.tailnet ? ["the tailnet"] : []), ...(binding?.lan ? ["the LAN"] : [])];
  const reach = networks.length === 0 ? "reachable from this machine only" : `reachable on ${networks.join(" and ")}`;
  return `${activity.state === "draining" ? "Restarting" : "Ready"} on ${version}, ${updates}, ${reach}.`;
};

/** The environment's lines for the steps it says more of when done than the registry's sentence (#1698), each read when the step is done. */
export const environmentDoneLines = (options: StateChecksOptions): DoneLines => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  return {
    "carry-over": carryOverDoneLine({ reader, detect: options.detectStateImport, stateImport: options.stateImport }),
    "your-machines": () => yourMachinesLine(options.version, options.status(), readSettings(reader)),
  };
};

export const environmentStateChecks = (options: StateChecksOptions): StateCheckers => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };
  const report = () => readPermissionsReport(reader, options.containment, options.isRoot);
  const presets = denylistPresets(options.dataDir);
  return {
    ...skillsStateChecks(options.skills),
    ...instructionsStateChecks(options.orientation),
    ...accountStateChecks({ accounts: options.accounts }),
    ...carryOverStateChecks({ accounts: options.accounts, adapters: options.adapters, reader, detect: options.detectStateImport, stateImport: options.stateImport }),
    "your-machines.not-root": () => runsAsNonRoot(report().isRoot),
    "your-machines.release-channel": options.releaseChannel,
    "your-machines.updates": options.updates,
    "your-machines.host-updater": options.hostUpdater,
    // Named from the first start (ADR 0025's "named"): the record's name, the preset icon and colour stand until set.
    "your-machines.named": () => (options.look().name.trim() !== "" ? true : { reason: "The environment has no name: rename it." }),
    "your-machines.ready": () => readyWithinCap(options.status(), options.clock.now()),
    // A start skips a LAN address the machine does not hold (#773): the step names it, read against the interfaces now.
    "your-machines.lan": () => {
      const lan = readSettings(reader)["network.bindLan"];
      const held = lan === null || lanAddressHeld(lan, options.lanAddresses());
      return held === true || { reason: `${held}: pick one it holds, or turn LAN binding off.` };
    },
    ...forgesStateChecks({ forge: options.forge, clock: options.clock }),
    ...keyManagerStateChecks({
      connections: () => options.keyManagerConnections.list(),
      requiredConnections: () => options.forge.list().flatMap((account) => account.credential.kind === "reference" ? [account.credential.reference.connectionId] : []),
      verify: () => options.keyManagerConnections.verify(),
      toolRows: async () => (await options.managedTools.list()).tools,
    }),
    ...memoryBankStateChecks(options.banks),
    ...options.browser.stateChecks,
    "permissions.containment": () => {
      const { values, containment } = report();
      return containmentDefaultHolds(values["permissions.containment.default"], containment);
    },
    "permissions.denylist": () => denylistHoldsPresets({ denylist: readDenylist(reader), changedBy: readDenylistChangedBy(reader) }, presets),
    "permissions.not-root": () => runsAsNonRoot(report().isRoot),
    "appearance.contrast": () => themeMeetsRules(readSettings(reader)["appearance.theme"]),
  };
};
