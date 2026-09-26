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

  it("draws the cursor's row, its line under it dropped, when the list has room for one line and each row takes two", () => {
    const tall: PanelRow[] = Array.from({ length: 3 }, (_, i) => ({ key: `acct-${i}`, cells: [{ text: `acct ${i}` }], dim: false, under: { text: `under ${i}` } }));
    for (const cursor of [0, 2]) {
      const app = render(createElement(Box, { width: 40, flexDirection: "column" }, createElement(ListCard, { title: "Accounts", hint: "", rows: tall, cursor, height: 2, width: 40 })));
      const frame = app.lastFrame() ?? "";
      expect(frame).toContain(`› acct ${cursor}`);
      expect(frame).not.toContain(`under ${cursor}`);
      expect(frame.split("\n").length).toBeLessThanOrEqual(2);
      app.unmount();
    }
  });

  it("keeps the line said when there are no rows within its height, with a lead, a footer and a child", () => {
    const card = createElement(
      ListCard,
      { title: "Accounts", hint: "", rows: [], cursor: 0, height: 5, width: 40, empty: "No accounts yet.", lead: [{ text: "read-only" }], footer: [[{ text: "a footer" }]], childRows: 1 },
      createElement(Text, null, "typed ▌"),
    );
    const app = render(createElement(Box, { width: 40, flexDirection: "column" }, card));
    const frame = app.lastFrame() ?? "";
    expect(frame.split("\n").length).toBeLessThanOrEqual(5);
    expect(frame).toContain("No accounts yet.");
    expect(frame).toContain("typed ▌");
    app.unmount();
  });
});
