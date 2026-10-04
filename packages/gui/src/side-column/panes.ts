import { FileDiff, Files, Globe, ListTodo, NotebookText, PanelsTopLeft, SquareTerminal, type LucideIcon } from "lucide-react";
import type { CapabilityAnswer, CapabilityName, Runtime } from "@agent-harness/client-runtime";
import type { SidePane } from "../presentation.js";

/**
 * The side column's panes (docs/specs/gui.md, "The seven panes and the
 * grid"): each one's icon and name in the rail and what it needs, whose capability
 * says whether it can draw. The terminal opens one over the environment's
 * `terminal`-scoped methods, and Files and Diff list over them; Documents
 * and Tasks list the session's own projections, which need none, and their
 * actions each say for themselves; the Preview reads through `files.read` and uses a static snapshot when
 * no desktop preview grant exists.
 */

interface PaneKind {
  /** Its name in the rail and the header's menu. */
  readonly label: string;
  readonly icon: LucideIcon;
  /** What it needs, asked in order: the first one absent is why it cannot draw. None for one that lists what the runtime already holds. */
  readonly needs: readonly CapabilityName[];
  /**
   * Whether it stays drawn while what it needs is absent, saying so itself: the terminal keeps the terminal it
   * draws through a spell the environment cannot be reached, and replays what it missed, refusing only a new one.
   */
  readonly drawnWhileAbsent: boolean;
}

export const PANES: Readonly<Record<SidePane, PaneKind>> = {
  terminal: { icon: SquareTerminal, label: "Terminal", needs: ["terminals.open"], drawnWhileAbsent: true },
  files: { icon: Files, label: "Files", needs: ["files.list"], drawnWhileAbsent: false },
  diff: { icon: FileDiff, label: "Diff", needs: ["diffs.session"], drawnWhileAbsent: false },
  documents: { icon: NotebookText, label: "Documents", needs: [], drawnWhileAbsent: false },
  tasks: { icon: ListTodo, label: "Tasks", needs: [], drawnWhileAbsent: false },
  browser: { icon: Globe, label: "Browser", needs: ["shell.webView"], drawnWhileAbsent: false },
  preview: { icon: PanelsTopLeft, label: "Preview", needs: ["files.read"], drawnWhileAbsent: false },
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

/** The measured order for the rail and the neighbour shown after closing a pane. */
export const DOCK_PANES: readonly SidePane[] = ["terminal", "browser", "files", "diff", "documents", "tasks", "preview"];
