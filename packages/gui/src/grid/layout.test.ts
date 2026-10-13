import { describe, expect, it } from "vitest";
import { PRESENTATION_DEFAULTS } from "../presentation.js";
import { addNewSession, addPane, openBeside, removePane, resizeRow } from "./layout.js";

const ONE_PANE = PRESENTATION_DEFAULTS.paneLayout;

describe("a row's equal shares", () => {
  it("shares the whole row when a third and fourth pane open beside the focused pane", () => {
    const two = addPane(ONE_PANE, ONE_PANE.focused, "right")!;
    const three = addPane(two, two.focused, "right")!;
    expect(three.rows[0]?.panes.map(pane => pane.width)).toEqual([100 / 3, 100 / 3, 100 / 3]);
    const four = addPane(three, three.focused, "right")!;
    expect(four.rows[0]?.panes.map(pane => pane.width)).toEqual([25, 25, 25, 25]);
    const closed = removePane(four, four.focused);
    expect(closed.rows[0]?.panes.map(pane => pane.width)).toEqual([100 / 3, 100 / 3, 100 / 3]);
  });
});

describe("the row's pixel floor", () => {
  it("includes divider space and refuses new panes and new-session surfaces without changing the layout", () => {
    const two = addPane(ONE_PANE, ONE_PANE.focused, "right", null, 727)!;
    expect(addPane(two, two.focused, "right", null, 1093)).toBeUndefined();
    expect(addNewSession(two, two.focused, "right", null, "new-surface", 1093)).toBeUndefined();
    const three = addPane(two, two.focused, "right", null, 1094)!;
    expect(three.rows[0]?.panes.map(pane => pane.width)).toEqual([100 / 3, 100 / 3, 100 / 3]);
    expect(two.rows[0]?.panes.map(pane => pane.width)).toEqual([50, 50]);
    expect(addPane(two, two.focused, "down", null, 727)?.rows).toHaveLength(2);
  });

  it("focuses an already shown session even when its row cannot fit another pane", () => {
    const session = { environmentId: "desk", sessionId: "session-for-tests" };
    const two = addPane(ONE_PANE, ONE_PANE.focused, "right", session, 727)!;
    const focused = { ...two, focused: ONE_PANE.focused };
    expect(openBeside(focused, focused.focused, "right", session, 727)?.focused).toBe(two.focused);
  });
});

it("keeps divider proportions until opening or closing a pane, and changes only that row", () => {
  const two = addPane(ONE_PANE, ONE_PANE.focused, "right")!;
  const rows = addPane(two, two.focused, "down")!;
  const firstRow = rows.rows[0]!;
  const adjusted = resizeRow(rows, firstRow.id, { [firstRow.panes[0]!.id]: 60, [firstRow.panes[1]!.id]: 40 });
  expect(adjusted.rows[0]?.panes.map(pane => pane.width)).toEqual([60, 40]);
  const three = addPane(adjusted, firstRow.panes[0]!.id, "right")!;
  expect(three.rows[0]?.panes.map(pane => pane.width)).toEqual([100 / 3, 100 / 3, 100 / 3]);
  expect(three.rows[1]).toBe(rows.rows[1]);
  expect(removePane(adjusted, firstRow.panes[0]!.id).rows[0]?.panes.map(pane => pane.width)).toEqual([100]);
});
