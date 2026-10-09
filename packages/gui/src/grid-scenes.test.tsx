import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import GridTwo from "../gallery/scenes/grid-two.js";
import GridDrop from "../gallery/scenes/grid-drop.js";
import { geometry as gridTwoGeometry, script, presentation } from "../gallery/scenes/grid-two.js";
import { measureSceneGeometry } from "../gallery/geometry.js";
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

// A browser revealing a focused control, or a scrollIntoView, scrolls a hidden-overflow box that no reader can scroll back:
// after a tall Permission card was answered, or after Stop, a pane's caption sat above it with a blank band below (#1948).
it("grid-two's pane cards clip what overflows them rather than hide it, so nothing can scroll a caption out of its pane", async () => {
  await renderApp(script, { presentation });
  await screen.findByRole("button", { name: "Rename “Check the ledger”" });
  const cards = Array.from(document.querySelectorAll("[data-grid-card]"));
  expect(cards).toHaveLength(2);
  for (const card of cards) expect(Array.from(card.classList).filter(name => name.startsWith("overflow-"))).toEqual(["overflow-clip"]);
});

it("the gallery fails a pane card a reveal could scroll, measured in the capture's real browser", () => {
  const root = document.createElement("div"); root.id = "root";
  root.dataset["galleryGeometry"] = JSON.stringify(gridTwoGeometry.filter(check => check.unscrollable === true));
  const card = document.createElement("div"); card.dataset["gridCard"] = "pane-1";
  root.append(card); document.body.append(root);
  try {
    // jsdom computes no longhand from the shorthand; a browser computes both.
    const overflow = (x: string, y: string) => { card.style.overflowX = x; card.style.overflowY = y; };
    for (const [x, y] of [["hidden", "hidden"], ["clip", "auto"], ["scroll", "clip"]] as const) {
      overflow(x, y);
      expect(measureSceneGeometry()).toEqual([expect.stringContaining("[data-grid-card][0]: scrolls")]);
    }
    overflow("clip", "clip");
    expect(measureSceneGeometry()).toEqual([]);
  } finally { root.remove(); }
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
