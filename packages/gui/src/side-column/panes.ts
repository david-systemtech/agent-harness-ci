import type { CapabilityAnswer, CapabilityName, Runtime } from "@agent-harness/client-runtime";
import type { SidePane } from "../presentation.js";

/**
 * The side column's panes (docs/specs/gui.md, "The seven panes and the
 * grid"): each one's name in the strip and what it needs, whose capability
 * says whether it can draw. The terminal opens one over the environment's
 * `terminal`-scoped methods, and Files and Diff list over them; Documents
 * and Tasks list the session's own projections, which need none, and their
 * actions each say for themselves; the Preview needs the shell's `preview`
 * (a browser tab has none: `no-shell`) and reads through `files.read`.
 */

interface PaneKind {
  /** Its name in the strip and the header's menu. */
  readonly label: string;
  /** What it needs, asked in order: the first one absent is why it cannot draw. None for one that lists what the runtime already holds. */
  readonly needs: readonly CapabilityName[];
  /**
   * Whether it stays drawn while what it needs is absent, saying so itself: the terminal keeps the terminal it
   * draws through a spell the environment cannot be reached, and replays what it missed, refusing only a new one.
   */
  readonly drawnWhileAbsent: boolean;
}

export const PANES: Readonly<Record<SidePane, PaneKind>> = {
  terminal: { label: "Terminal", needs: ["terminals.open"], drawnWhileAbsent: true },
  files: { label: "Files", needs: ["files.list"], drawnWhileAbsent: false },
  diff: { label: "Diff", needs: ["diffs.session"], drawnWhileAbsent: false },
  documents: { label: "Documents", needs: [], drawnWhileAbsent: false },
  tasks: { label: "Tasks", needs: [], drawnWhileAbsent: false },
  browser: { label: "Browser", needs: ["shell.webView"], drawnWhileAbsent: false },
  preview: { label: "Preview", needs: ["shell.preview", "files.read"], drawnWhileAbsent: false },
};

const PRESENT: CapabilityAnswer = { status: "present" };

/** Whether the pane can draw now: present, or absent with the capability's one line for the first thing it needs that is absent. */
export const paneCapability = (runtime: Runtime, environmentId: string, pane: SidePane): CapabilityAnswer => {
  for (const name of PANES[pane].needs) {
    const answer = runtime.capability(environmentId, name);
    if (answer.status === "absent") return answer;
  }
  return PRESENT;
};
