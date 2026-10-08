import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import GridTwo from "../gallery/scenes/grid-two.js";
import GridDrop from "../gallery/scenes/grid-drop.js";
import { script, presentation } from "../gallery/scenes/grid-two.js";
import { renderApp } from "../test/harness.js";

it("grid-two draws two real session captions with the workspace, branch, pull request and pane controls", async () => {
  await renderApp(script, { presentation });
  const first = await screen.findByRole("button", { name: "Rename “Check the ledger”" });
  const pane = within(first.closest('section[aria-label="Session pane"]') as HTMLElement);
  expect(pane.getByRole("note", { name: "Workspace: directory ledger" }).textContent).toBe("ledger");
  expect(pane.getByRole("button", { name: "Pull request #12, open" })).toBeDefined();
  expect(pane.getByRole("button", { name: "Run info" }).closest("[data-caption-run-info]")?.getAttribute("title")).toBe("Run info · Ctrl+I");
  expect(screen.getAllByRole("button", { name: "Close the pane" })).toHaveLength(2);
  const worktree = within(await screen.findByRole("note", { name: "Workspace: worktree ledger on review" }));
  expect(worktree.getByText("review")).toBeDefined();
});

it("grid-drop reveals the real caption-drag targets with dashed labels", async () => {
  const view = render(<GridDrop ladder="dark" />);
  try {
    const target = await screen.findByLabelText("Swap panes");
    expect(within(target).getByText("Swap panes")).toBeDefined();
    expect(screen.getByLabelText("Move to the right")).toBeDefined();
    expect(screen.getByLabelText("Move below")).toBeDefined();
    expect(screen.getAllByLabelText("Swap panes")).toHaveLength(1);
  } finally { view.unmount(); }
});

it("the gallery panes use a complete workspace-check script", async () => {
  const view = render(<GridTwo ladder="light" />);
  try {
    expect(await screen.findAllByText("After-edit check: off")).toHaveLength(2);
    expect(screen.queryByText(/The fake environment has no method/)).toBeNull();
  } finally { view.unmount(); }
});
