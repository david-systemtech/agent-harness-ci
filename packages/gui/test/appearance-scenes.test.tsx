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

it.each(["light", "dark"] as const)("draws the Theme scene in %s with client controls and both ladders", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-theme", ladder);
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-theme"));
  const pane = within(screen.getByRole("region", { name: "Theme" }));
  expect((pane.getByRole("spinbutton", { name: "Text size" }) as HTMLInputElement).value).toBe("14");
  expect(pane.getByRole("radiogroup", { name: "Reading width" })).toBeDefined();
  expect(pane.getByRole("switch", { name: "Streaming fade" })).toBeDefined();
  for (const name of ["Light ladder", "Dark ladder"]) expect(within(pane.getByRole("group", { name })).getAllByRole("img")).toHaveLength(7);
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: 'input[aria-label="Search settings"]', height: 32 });
  expect(document.documentElement.dataset["ladder"]).toBe(ladder);
});

it("draws shortcut groups with keycaps and can enter and cancel recording", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-shortcuts");
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-shortcuts"));
  const pane = within(screen.getByRole("region", { name: "Keyboard shortcuts" }));
  const row = within(pane.getByRole("row", { name: "Show or hide the sidebar" }));
  const button = row.getByRole("button", { name: "Ctrl+B" });
  expect(button.querySelector("kbd")?.textContent).toBe("Ctrl+B");
  const user = userEvent.setup();
  await user.click(button);
  await waitFor(() => expect(row.getByRole("button", { name: "Press a key…" }).getAttribute("aria-pressed")).toBe("true"));
  await user.keyboard("{Escape}");
  expect(row.getByRole("button", { name: "Ctrl+B" }).getAttribute("aria-pressed")).toBe("false");
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: 'table[aria-label="Anywhere"] kbd', height: 20 });
});

it("draws About with one client build, environment updates and managed tool rows", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-about");
  close = gallery.close;
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-about"));
  const pane = within(screen.getByRole("region", { name: "About" }));
  expect(pane.getAllByText(/^This client:/)).toHaveLength(1);
  expect(pane.getByText("linux · x64")).toBeDefined();
  expect(pane.getByRole("combobox", { name: "Channel" })).toBeDefined();
  expect(pane.getByRole("region", { name: "OpenBao CLI" })).toBeDefined();
  expect(within(pane.getByRole("region", { name: "OpenBao CLI" })).getByRole("button", { name: /Install/ })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-managed-tool]", paddingLeft: 12, paddingTop: 10 });
});
