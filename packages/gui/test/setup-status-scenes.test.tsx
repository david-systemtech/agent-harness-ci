import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
});

/** Mounts `name` in the dark and waits for its ready selector; the Skills card it shows. */
const mounted = async (name: string) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, name, "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
  return screen.getByRole("region", { name: "Skills" });
};

it("draws a done step's status: its state word and line, one Check again, and Open in Settings with its hint", async () => {
  const skills = await mounted("setup-status-done");
  expect(within(skills).getByText("Done", { selector: "[data-state-word]" })).toBeDefined();
  expect(within(skills).getByText("Your skills are ready.")).toBeDefined();
  expect(within(skills).getAllByRole("button", { name: "Check again" })).toHaveLength(1);
  expect(within(skills).getByRole("button", { name: "Open in Settings" })).toBeDefined();
  expect(within(skills).getByText("Leaves Set up")).toBeDefined();
});

it("draws a step needing a fix as a notice with its fixes in place and Details open", async () => {
  const skills = await mounted("setup-status-fix");
  const notice = within(skills).getByRole("alert");
  expect(within(notice).getByRole("button", { name: "Update now: team-skills" })).toBeDefined();
  expect(within(notice).getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("true");
  expect(notice.querySelector("pre")?.textContent).toContain("Checks: skills.sources-synced");
});

it("draws a check that could not run as Set up opened, with Check again", async () => {
  const skills = await mounted("setup-status-could-not-check");
  const notice = within(skills).getByText("agent-harness could not run the check.").closest<HTMLElement>("[role=alert]") as HTMLElement;
  expect(within(notice).getByRole("button", { name: "Check again" })).toBeDefined();
});

it("draws the reach line of a computer this app cannot reach, with Try again", async () => {
  await mounted("setup-status-unreachable");
  const line = screen.getByText(/^This app cannot reach desk/).closest<HTMLElement>("[data-reach-line]") as HTMLElement;
  expect(within(line).getByRole("button", { name: "Try again" })).toBeDefined();
});
