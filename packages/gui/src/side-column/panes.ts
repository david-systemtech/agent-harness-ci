import type { CapabilityAnswer, Runtime } from "@agent-harness/client-runtime";
import type { MethodName } from "@agent-harness/contracts";
import type { SidePane } from "../presentation.js";

/**
 * The side column's panes (docs/specs/gui.md, "The seven panes and the
 * grid"): each one's name in the strip and the method it lists over, whose
 * capability says whether the connection can call it. The terminal opens
 * one over the environment's `terminal`-scoped methods, and Files and Diff
 * list over them; Tasks lists the session's own projection, which needs
 * none, and its stop and its agents' transcripts each say for themselves.
 */

interface PaneKind {
  /** Its name in the strip and the header's menu. */
  readonly label: string;
  /** The method it lists over; null for one that lists what the runtime already holds. */
  readonly method: MethodName | null;
  /**
   * Whether it stays drawn while its method cannot be called, saying so itself: the terminal keeps the terminal it
   * draws through a spell the environment cannot be reached, and replays what it missed, refusing only a new one.
   */
  readonly drawnWhileAbsent: boolean;
}

export const PANES: Readonly<Record<SidePane, PaneKind>> = {
  terminal: { label: "Terminal", method: "terminals.open", drawnWhileAbsent: true },
  files: { label: "Files", method: "files.list", drawnWhileAbsent: false },
  diff: { label: "Diff", method: "diffs.session", drawnWhileAbsent: false },
  tasks: { label: "Tasks", method: null, drawnWhileAbsent: false },
};

const PRESENT: CapabilityAnswer = { status: "present" };

/** Whether the connection can call the pane's method now: present, or absent with the capability's one line. */
export const paneCapability = (runtime: Runtime, environmentId: string, pane: SidePane): CapabilityAnswer => {
  const { method } = PANES[pane];
  return method === null ? PRESENT : runtime.capability(environmentId, method);
};
