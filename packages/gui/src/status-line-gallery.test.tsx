import { fireEvent, screen, within } from "@testing-library/react";
import { whenWords } from "@agent-harness/contracts";
import { expect, it, onTestFinished, vi } from "vitest";
import * as phoneUsageScene from "../gallery/scenes/phone-composer-details-usage.js";
import * as statusScene from "../gallery/scenes/status-line.js";
import * as usageDetailsScene from "../gallery/scenes/status-line-usage-details.js";
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
  // The sheet stacks its rows in a column, where the rings' auto margin would size them to their content: capped at the
  // sheet's width, the captions truncate instead of pushing a ring past the edge at text size 20.
  expect(gauge.parentElement!.className.split(" ")).toContain("max-w-full");
});

// #1951: the gallery scene of the popover, opened by its own activate.
it("status-line-usage-details opens the popover with one silent-limits line and the times in words", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "status-line-usage-details", "dark", { "status-line-usage-details": usageDetailsScene });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const details = await screen.findByRole("dialog", { name: "Usage details" });
  const now = new Date("2026-09-24T00:00:00.000Z");
  expect(await within(details).findByText("2 other limits give no reading.")).toBeTruthy();
  expect(within(details).getAllByText("Other limit")).toHaveLength(1);
  expect(details.textContent).toContain(`Resets ${whenWords("2026-09-24T01:44:00.000Z", now)} · in 1h 44m`);
  expect(details.textContent).toContain(`Resets ${whenWords("2026-09-28T00:00:00.000Z", now)} · in 96h 00m`);
  expect(within(details).getByLabelText("Reading age").textContent).toBe(`Read 51s ago · ${whenWords("2026-09-23T23:59:09.000Z", now)}`);
  expect(details.textContent).not.toMatch(/\d{4}-\d\d-\d\dT/);
});
