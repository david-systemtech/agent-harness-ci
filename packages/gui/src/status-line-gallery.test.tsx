import { screen, within } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import * as statusScene from "../gallery/scenes/status-line.js";
import { mountGallery } from "../gallery/mount.js";

it("status-line captions the model bucket by the model alone and labels the context ring Context", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "status-line", "dark", { "status-line": statusScene });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const gauges = await screen.findAllByRole("group", { name: "Plan usage" });
  expect(gauges).toHaveLength(3);
  for (const gauge of gauges) {
    expect(await within(gauge).findByText("Fable")).toBeTruthy();
    expect(within(gauge).queryByText(/^Weekly,/)).toBeNull();
  }
  const contexts = await screen.findAllByRole("button", { name: "Context usage" });
  expect(contexts.map((button) => button.textContent)).toEqual(["Context20", "Context80", "Context95"]);
});
