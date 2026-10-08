import { fireEvent, screen, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import * as phoneUsageScene from "../gallery/scenes/phone-composer-details-usage.js";
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

it("phone-composer-details-usage shows the Context and model rings in the Run settings sheet", async () => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query === "(width < 640px)", media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-composer-details-usage", "dark",
    // The scene's own activate proves the sheet's placement in a real browser; here the test opens the sheet.
    { "phone-composer-details-usage": { platform: "web", route: phoneUsageScene.route!, script: phoneUsageScene.script, arrangeWeb: phoneUsageScene.arrangeWeb } }, { platform: "web" });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  fireEvent.click(await screen.findByRole("button", { name: "Run settings" }));
  const sheet = await screen.findByRole("dialog", { name: "Run settings" });
  const gauge = await within(sheet).findByRole("group", { name: "Plan usage" });
  expect(await within(gauge).findByText("Fable")).toBeTruthy();
  expect(within(gauge).getByText("5-hour")).toBeTruthy();
  expect(within(gauge).queryByText(/^Weekly,/)).toBeNull();
  expect((await within(sheet).findByRole("button", { name: "Context usage" })).textContent).toBe("Context80");
});
