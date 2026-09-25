import { Box, Text } from "ink";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ListCard } from "./cards.js";
import type { PanelRow } from "./panel.js";

/** The list card keeps to the lines it is given, a wrapped footer and a typed line counted (PR review). */

const rows: PanelRow[] = Array.from({ length: 12 }, (_, i) => ({ key: `row-${i}`, cells: [{ text: `row ${i}` }], dim: false }));
const sentence = "The agent will act without asking and can do anything this account can, within the containment you chose.";

describe("ListCard", () => {
  it("counts a footer line by the rows it wraps to, and the rows a child takes, so the card stays within its height", () => {
    const card = createElement(
      ListCard,
      { title: "Mode", hint: "", rows, cursor: 11, height: 8, width: 40, footer: [[{ text: sentence }]], childRows: 1 },
      createElement(Text, null, "typed ▌"),
    );
    const app = render(createElement(Box, { width: 40, flexDirection: "column" }, card));
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(8);
    // The cursor's row, the whole sentence and the child are all in sight.
    expect(frame).toContain("› row 11");
    expect(frame.replace(/\s+/g, " ")).toContain(sentence);
    expect(frame).toContain("typed ▌");
    app.unmount();
  });
});
