import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

/** Mounts `name` in the dark and waits for its ready selector; the Set up pane it shows. */
const mounted = async (name: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, name, "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
  return within(screen.getByRole("dialog", { name: "Settings" })).getByRole("region", { name: "Set up" });
};

it("draws the pane's rows in every state, each with its state word and its whole line, and the counts", async () => {
  const pane = await mounted("settings-setup");
  expect(await within(pane).findByText("2 done · 2 need a fix · 1 not set up · 1 checking")).toBeDefined();
  const words = [...pane.querySelectorAll("[data-setup-summary] [data-state-word]")].map((word) => word.textContent);
  expect(new Set(words)).toEqual(new Set(["Done", "Checking", "Needs a fix", "Not checked yet", "Not set up"]));
  expect(within(pane).getByText("The token for git.example.test has run out, so agents cannot push to your forge. Add a new token.")).toBeDefined();
  expect(within(pane).getByRole("button", { name: "Check everything again" })).toBeDefined();
  expect(within(pane).getByRole("button", { name: "Open Set up" })).toBeDefined();
  expect(within(pane).getByRole("button", { name: "Set up another computer" })).toBeDefined();
});

it("draws Check everything again finding every step fine, a step not set up among them", async () => {
  const pane = await mounted("settings-setup-passed");
  expect(within(pane).getByRole("status").textContent).toBe("Everything on desk is set up.");
});

it("draws Check everything again running, busy and disabled", async () => {
  const pane = await mounted("settings-setup-checking");
  const busy = within(pane).getByRole("button", { name: "Checking…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
});

it("draws a Check everything again that could not check as an alert with Details", async () => {
  const pane = await mounted("settings-setup-refused");
  const alert = within(pane).getByRole("alert");
  expect(alert.textContent).toContain("agent-harness could not check desk.");
  expect(within(alert).getByRole("button", { name: "Details" })).toBeDefined();
});
