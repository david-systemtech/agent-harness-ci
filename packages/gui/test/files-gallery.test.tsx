import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it("renders the file-view scene with source text, four numbered lines and the measured gutter", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "dock-file-view");
  close = gallery.close;
  const files = within(await screen.findByRole("region", { name: "Files" }));
  expect(await files.findByText("4 lines")).toBeDefined();
  expect(files.getByRole("code").textContent).toContain("values.reduce");
  expect(files.getByLabelText("Line numbers").textContent).toBe("1234");
  expect(files.getByRole("button", { name: "Pin file" })).toBeDefined();
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("dock-file-view"));
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: "[data-file-gutter]", width: 40 });
});
