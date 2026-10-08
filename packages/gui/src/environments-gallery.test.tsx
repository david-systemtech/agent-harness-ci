import { screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import type { LadderName } from "@agent-harness/theme";

const mount = async (name: string, ladder: LadderName) => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, name, ladder);
  onTestFinished(async () => { await gallery.close(); container.remove(); });
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
};

it("draws the Your machines scene with named cards, pairing QR and measured controls", async () => {
  const { geometry } = await import("../gallery/scenes/settings-machines.js");
  await mount("settings-machines", "dark");
  const settings = await screen.findByRole("region", { name: "Settings" });
  const pane = await within(settings).findByRole("region", { name: "Your machines" });
  const desk = await within(pane).findByRole("region", { name: "desk" });
  expect(await within(desk).findByRole("img", { name: "QR code of the pairing link" })).toBeTruthy();
  expect(within(desk).getByRole("button", { name: "Copy pairing link" })).toBeTruthy();
  expect(within(pane).getByRole("region", { name: "Add a device" })).toBeTruthy();
  for (const rule of geometry({ width: 1400, height: 900 })) expect(document.querySelector(rule.selector), rule.selector).not.toBeNull();
});

it("draws the Access scene with client scopes, a program and a phone's revoke confirmation naming its browser and when it paired", async () => {
  const { geometry } = await import("../gallery/scenes/settings-access.js");
  await mount("settings-access", "light");
  const asked = await screen.findByRole("dialog", { name: "Revoke Chrome on Android (Home Screen) on desk?" });
  expect(within(asked).getByText(/^Browser · read, sessions:write, runs:drive · paired \d\d:\d\d · last seen \d\d:\d\d$/)).toBeTruthy();
  expect(screen.getByText("This client")).toBeTruthy();
  expect(screen.getByText("Build helper")).toBeTruthy();
  for (const rule of geometry({ width: 1400, height: 900 })) expect(document.querySelector(rule.selector), rule.selector).not.toBeNull();
});

it("draws the Service scene with the drain consequence and named session settings", async () => {
  const { geometry } = await import("../gallery/scenes/settings-service.js");
  await mount("settings-service", "dark");
  expect(await screen.findByRole("dialog", { name: "Drain desk?" })).toBeTruthy();
  expect(screen.getByText("desk refuses new runs, lets the running ones finish for up to 30 minutes, then stops.")).toBeTruthy();
  expect(await screen.findByText("Settle idle sessions")).toBeTruthy();
  for (const rule of geometry({ width: 1400, height: 900 })) expect(document.querySelector(rule.selector), rule.selector).not.toBeNull();
});
