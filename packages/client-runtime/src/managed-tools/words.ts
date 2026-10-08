import type {
  ManagedTool,
  ManagedToolInstallMethod,
  ManagedToolRow,
  ManagedToolStatus,
  ManagedToolVerification,
  ManagedToolVerifyOutcome,
  RunnableToolAction,
  ToolDoctorReport,
  ToolRunFinishedPayload,
} from "@agent-harness/contracts";
import { KEY_MANAGER_PROVIDER_WORDS } from "../key-managers/words.js";

/**
 * What About's Managed tools say of a row (key-managers spec, "Managed
 * tools"; ADR 0026; #426): its status and install method, when it is
 * required, its action's button, what a verify command found, how a run
 * ended and what `claude doctor` reports. The rows are the environment's
 * probe; nothing here probes or reads a version itself.
 */

/** What each status says on a row; `update-available` is a badge only (ADR 0026). */
export const MANAGED_TOOL_STATUS_WORDS: Readonly<Record<ManagedToolStatus, string>> = {
  current: "Current",
  "update-available": "Update available",
  "below-minimum": "Below minimum",
  "not-installed": "Not installed",
  "method-unknown": "Method unknown",
};

/** What each install method is called on a row. */
export const INSTALL_METHOD_WORDS: Readonly<Record<ManagedToolInstallMethod, string>> = {
  homebrew: "Homebrew",
  winget: "WinGet",
  scoop: "Scoop",
  mise: "mise",
  asdf: "asdf",
  npm: "npm",
  native: "Its native installer",
  apt: "apt",
  dnf: "dnf",
  manual: "By hand",
  unknown: "Not known",
};

/** When the tool is required, as its row says it: `claude` never is, since the harness runs the Claude Code it bundles. */
export const requiredWords = ({ requiredFor }: Pick<ManagedTool, "requiredFor">): string => {
  switch (requiredFor.kind) {
    case "never":
      return "Never: it is for your own use.";
    case "key-manager":
      return `While a key manager of ${KEY_MANAGER_PROVIDER_WORDS[requiredFor.provider]} injects into runs.`;
    case "forge-gh":
      return "While a forge account reads its token from this environment's gh.";
  }
};

/**
 * The button a row's action is: Install (`vault`'s installs `bao`, since
 * `vault` is never installed), Update, or Run in a terminal pane, the
 * vendor's command held back in a tool terminal until Enter (#1833).
 */
export const runWords = (row: Pick<ManagedToolRow, "tool">, action: RunnableToolAction): string => {
  switch (action) {
    case "update":
      return "Update";
    case "terminal":
      return "Run in a terminal pane";
    case "install":
      return row.tool === "vault" ? "Install bao" : "Install";
  }
};

/** What a Run in a terminal pane row says of its command (#1833): it waits for Enter in the tool terminal, and can be copied besides. */
export const terminalCommandWords = (row: Pick<ManagedToolRow, "label">): string =>
  `The harness does not update the ${row.label} installed this way by itself: Run in a terminal pane types out the vendor's command, which runs when you press Enter there.`;

/** What a Copy row says where the command table has none for it here: `vault`, which the harness never installs or updates. */
export const noCommandWords = (row: Pick<ManagedToolRow, "label">): string => `The harness has no command for the ${row.label} here: update it the way it was installed.`;

const VERIFY_WORDS: Readonly<Record<ManagedToolVerifyOutcome, string>> = { passed: "Verified", failed: "Verify failed", "not-installed": "Not installed" };

/** A verify command's outcome in one line, with the environment's reason. */
export const verificationWords = (verification: Pick<ManagedToolVerification, "outcome" | "reason">): string => `${VERIFY_WORDS[verification.outcome]}: ${verification.reason}`;

/** How a tool run ended (`tool.run-finished`), then what the verify command after it found. */
export const toolRunWords = (finished: ToolRunFinishedPayload): string => {
  const run = finished.action === "install" ? `The install of ${finished.tool}` : `The update of ${finished.tool}`;
  const ended =
    finished.cause === "closed"
      ? "was closed before it finished."
      : finished.cause === "failed"
        ? "could not start."
        : finished.signal !== null
          ? `was killed by signal ${String(finished.signal)}.`
          : finished.exitCode === 0
            ? "finished."
            : `exited with code ${String(finished.exitCode)}.`;
  return finished.verification === null ? `${run} ${ended}` : `${run} ${ended} ${verificationWords(finished.verification)}`;
};

/** The install method `claude doctor` reports, set beside the detected one; or why it reports none. */
export const doctorMethodWords = (doctor: ToolDoctorReport): string => {
  switch (doctor.outcome) {
    case "read":
      return doctor.method === null ? "One the harness does not name (a development build, pacman or apk)" : INSTALL_METHOD_WORDS[doctor.method];
    case "failed":
      return `Nothing it could read: ${doctor.reason}`;
    case "not-installed":
      return "Nothing: it is not installed.";
  }
};
