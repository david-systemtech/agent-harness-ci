import type { DesktopKind, RunDesktopResolution, SessionDesktop } from "@agent-harness/contracts";

/**
 * The desktop picker both renderers draw (computer spec, "Session field and
 * run resolution"; ADR 0038; #2161), beside the browser's: a pure function
 * of the session's `desktop` field, as its summary holds it, and of what the
 * latest run resolved it to. Its rows are what `sessions.setDesktop` can set
 * the field to. A null field was never set and resolves as none.
 */

/** One row of the desktop picker. */
export interface DesktopRow {
  /** What choosing it sets the session's desktop to. */
  readonly value: SessionDesktop;
  readonly label: string;
  /** What choosing it does. */
  readonly note: string;
  /** The session's desktop now (null marking none): the row a picker marks. */
  readonly selected: boolean;
}

export interface DesktopPickerView {
  /** The rows, in the picker's order: none, contained, local. */
  readonly rows: readonly DesktopRow[];
  /** The session's desktop as its field resolves it: a null field is none. */
  readonly chosen: SessionDesktop;
  /**
   * Why the latest run has no desktop when it asked for one: present only
   * when it resolved to none for a reason other than none being requested.
   */
  readonly refused: RunDesktopResolution | null;
}

const ROWS: readonly Omit<DesktopRow, "selected">[] = [
  { value: { kind: "none" }, label: "No desktop", note: "The agent cannot see or drive a desktop." },
  { value: { kind: "contained" }, label: "Contained desktop", note: "The desktop configured on the session's environment, which the agent can see, click and type in." },
  { value: { kind: "local" }, label: "This computer's desktop", note: "Your live desktop, which the agent can see, click and type in while you watch." },
];

/** The label of a desktop kind, as the picker names it. */
export const desktopLabel = (kind: DesktopKind): string => ROWS.find((row) => row.value.kind === kind)?.label ?? kind;

/**
 * The picker for a session whose `desktop` field is `field` (null when never
 * set, undefined while not known, both marking none) and whose latest run
 * resolved its desktop as `resolution`, when it has.
 */
export const desktopPicker = (field: SessionDesktop | null | undefined, resolution?: RunDesktopResolution): DesktopPickerView => {
  const chosen: SessionDesktop = field ?? { kind: "none" };
  return {
    rows: ROWS.map((row) => ({ ...row, selected: row.value.kind === chosen.kind })),
    chosen,
    refused: resolution !== undefined && resolution.desktop.kind === "none" && resolution.reason !== "none" ? resolution : null,
  };
};
