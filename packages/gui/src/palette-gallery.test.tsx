import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

it.each(["palette-root", "palette-sessions"])("captures %s with the real modal, icons and geometry contract", async (scene) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  await waitFor(() => expect(within(dialog).getByRole("combobox", { name: scene === "palette-root" ? "Search the commands" : "Search the sessions on every environment" })).toBeTruthy());
  if (scene === "palette-sessions") {
    expect(within(dialog).getAllByRole("option")).toHaveLength(10);
    expect(within(dialog).getByText("task/receipts-1")).toBeTruthy();
  } else {
    expect(within(dialog).getByRole("group", { name: "Configure" })).toBeTruthy();
    expect(within(dialog).getByText("Nothing is running in this session.")).toBeTruthy();
  }
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "null")).toEqual(expect.arrayContaining([
    { selector: '[data-measure="palette"]', width: 384 },
    { selector: '[cmdk-list]', height: 352 },
  ]));
});

it("the no-match scene keeps its query and empty feedback visible", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "palette-no-match");
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name: "Command palette" });
  await within(dialog).findByText("No session matches that.");
  expect((within(dialog).getByRole("combobox", { name: "Search the sessions on every environment" }) as HTMLInputElement).value).toBe("no-such-command");
});
