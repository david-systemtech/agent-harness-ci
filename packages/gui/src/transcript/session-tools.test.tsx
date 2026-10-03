import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import SessionToolsScene, { geometry } from "../../gallery/scenes/session-tools.js";

it("draws both activity states, edit details, live and quiet status, failure output and named document controls", () => {
  render(<SessionToolsScene />);
  const closed = screen.getByRole("region", { name: "Closed activity group" });
  const open = screen.getByRole("region", { name: "Open activity group" });
  expect(within(closed).getByRole("button").getAttribute("aria-expanded")).toBe("false");
  expect(within(open).getAllByRole("group")).toHaveLength(4);
  expect(within(open).getByRole("button", { name: "Edit: src/totals.ts" }).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("No output for 3 min")).toBeDefined();
  expect(screen.getByText("not_found: No file missing.ts in the workspace.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Preview chart.svg" }).getAttribute("aria-disabled")).toBe("true");
  expect(geometry).toContainEqual({ selector: "[data-diff-gutter]", width: 40, tolerance: 0.1 });
});
