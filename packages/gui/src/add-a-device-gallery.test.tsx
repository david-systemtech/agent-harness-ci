import { screen, waitFor, within } from "@testing-library/react";
import type { LadderName } from "@agent-harness/theme";
import { expect, it, onTestFinished } from "vitest";
import { addADeviceGeometry } from "../gallery/add-a-device-scene.js";
import { mountGallery } from "../gallery/mount.js";

/**
 * Add a device's gallery scenes (setup-copy.md §5.5, §4.2; #1847): each is
 * drawn and ready in the state it names, with every element its geometry
 * measures present.
 */

const mount = async (name: string, ladder: LadderName = "dark") => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, name, ladder);
  onTestFinished(async () => { await gallery.close(); container.remove(); });
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
  for (const rule of addADeviceGeometry({ width: 1400, height: 900 })) expect(document.querySelector(rule.selector), rule.selector).not.toBeNull();
  return within(within(await screen.findByRole("region", { name: "Settings" })).getByRole("region", { name: "Add a device" }));
};

it("draws who a code is for, Me pre-selected", async () => {
  const add = await mount("settings-add-a-device");
  expect(add.getByRole("radio", { name: "Me" }).getAttribute("aria-checked")).toBe("true");
});

it("draws a code made, with its QR and its minutes", async () => {
  const add = await mount("settings-add-a-device-code");
  expect(add.getByRole("img", { name: "QR code of the pairing link" })).toBeDefined();
  expect(add.getByRole("timer").textContent).toBe("This code works once, for 10 minutes. 10 min left.");
});

it("draws this computer reachable only from itself: the warning, and the code that only works here, with no QR", async () => {
  const add = await mount("settings-add-a-device-local");
  expect(add.getByText("Other devices cannot reach this computer yet, so they cannot use a code made now. Set up Tailscale first.")).toBeDefined();
  expect(add.getByText("This code only works on this computer.")).toBeDefined();
  expect(add.queryByRole("img", { name: "QR code of the pairing link" })).toBeNull();
});

it("draws Part 2's refusal when nothing answers, as an alert in plain words", async () => {
  const add = await mount("settings-add-a-device-refused");
  const refusal = add.getByRole("region", { name: "Connect this app to another computer" }).querySelector("[data-pairing-refusal]");
  expect(refusal?.textContent).toMatch(/^Error: Nothing answered at laptop\.test:\d+\. Check that the other computer is on and that both are connected to Tailscale\./);
});
