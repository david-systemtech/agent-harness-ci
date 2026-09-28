/**
 * The parity contract's named gaps (ADR 0004; docs/specs/tui.md and
 * docs/specs/gui.md, "The parity contract in practice"): each surface the GUI
 * draws that the terminal UI cannot. A gap is a tracker issue labelled
 * `parity`, David deciding it, and is listed here with that issue's number;
 * ADR 0017's contract test fails on a gap listed without one. A capability an
 * environment reports absent is not a gap: it is the runtime's
 * absent-with-reason line.
 */
export interface ParityGap {
  readonly id: string;
  /** What the GUI draws and the terminal UI cannot, in one line. */
  readonly description: string;
  /** The `parity` issue holding David's decision; null for a gap named before its issue is filed, which the contract test refuses. */
  readonly issue: number | null;
}

export const PARITY_GAPS: readonly ParityGap[] = [
  { id: "browser-dock", description: "The browser dock: a web page beside a session pane.", issue: 465 },
  { id: "preview", description: "The preview pane: a page or an SVG the session wrote, rendered.", issue: 466 },
  { id: "drag-reordering", description: "Reordering, grouping and pinning a session by dragging it; the terminal UI moves it by keys.", issue: 467 },
  { id: "images", description: "Images drawn inline beyond the kitty, iTerm2, WezTerm and Ghostty image protocols.", issue: 468 },
  { id: "pane-grid", description: "Up to eight session panes side by side; the terminal UI shows one session at a time.", issue: 469 },
];
