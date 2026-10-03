import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["dock-documents", "dock-tasks", "dock-diff"] as const)("draws %s through the real window with measured geometry", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(scene));
  const name = { "dock-documents": "Documents", "dock-tasks": "Tasks", "dock-diff": "Diff" }[scene]!;
  const pane = within(await screen.findByRole("region", { name }));
  const geometry = JSON.parse(container.dataset["galleryGeometry"] ?? "[]");
  expect(geometry).toContainEqual({ selector: "[data-dock-rail]", width: 40 });
  expect(geometry).toContainEqual({ selector: "section:not([hidden]) > [data-dock-header]", height: 30 });
  if (scene === "dock-documents") {
    expect(await pane.findByRole("article", { name: "site/index.html" })).toBeDefined();
    expect(pane.getAllByRole("article")).toHaveLength(3);
    expect(geometry).toContainEqual({ selector: "[data-document-glyph]", width: 24, height: 24 });
  } else if (scene === "dock-tasks") {
    expect(await pane.findByRole("list", { name: "Live work" })).toBeDefined();
    expect(within(pane.getByRole("list", { name: "Live work" })).getAllByRole("article")).toHaveLength(3);
    expect(geometry).toContainEqual({ selector: "[data-task-status] svg", width: 12, height: 12 });
    const user = userEvent.setup();
    await user.click(pane.getByRole("button", { name: "3 finished" }));
    expect(within(pane.getByRole("list", { name: "Finished work" })).getAllByRole("article")).toHaveLength(3);
    await user.click(within(pane.getByRole("article", { name: "Explore: Find the parser" })).getByRole("button", { name: "Open" }));
    expect(await pane.findByRole("group", { name: "The agent's transcript" })).toBeDefined();
    expect(pane.getByText("The parser is in src/parser.ts.")).toBeDefined();
    expect(pane.getByRole("button", { name: "Back to the tasks" })).toBeDefined();
  } else {
    const session = await pane.findByRole("group", { name: "What this session changed" });
    await within(session).findByRole("article", { name: "src/totals.ts" });
    expect(pane.getByRole("group", { name: "The working tree against HEAD" })).toBeDefined();
    expect(geometry).toContainEqual({ selector: "[data-diff-gutter]", width: 40 });
    expect(geometry).toContainEqual({ selector: '[aria-label="Diff"] button[aria-label="Read again"]', width: 24, height: 24 });
  }
});
