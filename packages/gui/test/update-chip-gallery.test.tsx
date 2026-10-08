import { screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

/** Each state of the update chip, its words in full: the header's chip and About's button (#1806). */
const STATES = [
  ["ready", "Restart to update", "button"],
  ["ready-after-failed-check", "Restart to update", "button"],
  ["checking", "Checking for an update…", "status"],
  ["staging", "Downloading update…", "status"],
  ["applying", "Restarting to update…", "status"],
  ["failed", "Update failed", "status"],
  ["install-failed", "Update failed", "button"],
] as const;

it("draws the update chip in every state at look's 2xs mono, as wide as its words rather than a fixed cap", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "update-chip");
  try {
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe("update-chip"));
    for (const [state, label, role] of STATES) {
      const part = (name: string) => within(container.querySelector<HTMLElement>(`[data-update-chip="${state}"] [data-geometry="${name}"]`) ?? screen.getByText(`no ${state} ${name}`));
      const chip = part("header").getByRole(role);
      expect(chip.textContent).toBe(label);
      const about = part("about").queryByRole("button");
      expect(about?.textContent ?? null).toBe(label === "Restart to update" ? label : null);
      for (const drawn of [chip, ...(about === null ? [] : [about])]) {
        expect(drawn.className.split(" ")).toEqual(expect.arrayContaining(["h-[22px]", "font-mono", "text-2xs", "w-fit"]));
        expect(drawn.className).not.toMatch(/(^| )(max-w-|text-xs( |$))/);
      }
    }
    const checks: unknown = JSON.parse(container.dataset["galleryGeometry"] ?? "null");
    expect(checks).toEqual(expect.arrayContaining(STATES.flatMap(([state]) => [
      { selector: `[data-update-chip="${state}"] [data-geometry="header"] :is(button, [role="status"]) > span`, contentFits: true, fontSize: 11 },
      { selector: `[data-update-chip="${state}"] [data-geometry="header"] :is(button, [role="status"])`, height: 22 },
    ])));
    expect(checks).toEqual(expect.arrayContaining([
      { selector: '[data-update-chip="ready"] [data-geometry="about"] button > span', contentFits: true, fontSize: 11 },
      { selector: '[data-update-chip="ready"] [data-geometry="about"] button', height: 22 },
    ]));
  } finally {
    await gallery.close();
    container.remove();
  }
});
