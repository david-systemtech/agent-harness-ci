import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); });

it.each([
  ["dialog-pairing", "Pair with an environment", 512],
  ["dialog-restore", "Restore a deleted session", 512],
  ["dialog-run-info", "Run info", 512],
  ["dialog-hand-off", "Hand off Check the receipts on desk", 560],
] as const)("renders %s with its real dialog and measured width", async (scene, name, width) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, scene);
  close = gallery.close;
  const dialog = await screen.findByRole("dialog", { name });
  expect(within(dialog).getByRole("button", { name: "Close dialog" }).querySelector("svg")).not.toBeNull();
  await waitFor(() => expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toContainEqual({ selector: '[role="dialog"]', width }));
  if (scene === "dialog-restore") expect(await within(dialog).findByRole("button", { name: "Restore “Earlier receipts”" })).toBeTruthy();
  if (scene === "dialog-run-info") for (const group of ["Run", "Account", "Usage", "Capabilities", "Tools"]) expect(within(dialog).getByRole("region", { name: group })).toBeTruthy();
  if (scene === "dialog-hand-off") expect(await within(dialog).findByRole("button", { name: /^spare/ })).toBeTruthy();
});
