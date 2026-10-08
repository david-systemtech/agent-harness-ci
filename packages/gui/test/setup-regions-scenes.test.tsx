import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it.each(["light", "dark"] as const)("shows four bounded setup regions in %s", async (ladder) => {
  for (const name of ["setup-browser", "setup-carry-over", "setup-bank-preview", "setup-authoring"]) {
    const container = document.createElement("div");
    document.body.append(container);
    const gallery = await mountGallery(container, name, ladder);
    close = gallery.close;
    expect(await gallery.ready).toBe(true);
    await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
    const footer = screen.getByRole("navigation", { name: "Step navigation", hidden: name === "setup-authoring" });
    expect(container.querySelector("[data-setup-scroll]")?.contains(footer)).toBe(false);
    expect(within(footer).getByRole("button", { name: "Continue", hidden: name === "setup-authoring" })).toBeDefined();
    if (name !== "setup-authoring") expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
      { selector: 'nav[aria-label="Set up steps"]', width: 280 },
      { selector: '[data-setup-scroll] > div', maxWidth: 620 },
    ]));
    if (name === "setup-browser") {
      for (const heading of ["Load the extension", "Pair", "Sites you are developing", "Done"]) {
        expect(screen.getByRole("heading", { name: heading })).toBeDefined();
      }
      expect(within(screen.getByRole("region", { name: "Browser" })).queryAllByRole("checkbox")).toHaveLength(0);
      expect(screen.getByRole("img", { name: "4. Done: complete" })).toBeDefined();
      expect(screen.getByRole("region", { name: "Using your browser" })).toBeDefined();
    }
    if (name === "setup-carry-over") {
      expect(within(screen.getByLabelText("Sessions")).getByText("Sessions").nextElementSibling?.textContent).toBe("24");
      expect(screen.getByRole("button", { name: "Import 8 new sessions" })).toBeDefined();
    }
    if (name === "setup-bank-preview") {
      const preview = screen.getByRole("region", { name: "Notebook preview" });
      for (const heading of ["team-memory: Project agreements and useful discoveries.", "Owners", "Projects"]) expect(within(preview).getByRole("heading", { name: heading })).toBeDefined();
      expect(within(preview).getByText("Shared with the team: no personal facts, no secrets.")).toBeDefined();
    }
    if (name === "setup-authoring") {
      const conversation = screen.getByRole("region", { name: "Authoring conversation" });
      expect(await within(conversation).findByRole("heading", { name: "Set up: Memory bank" })).toBeDefined();
      expect(within(conversation).getByRole("textbox", { name: "Message" })).toBeDefined();
      expect(within(conversation).getByRole("button", { name: "Open in the main window" })).toBeDefined();
    }
    await close();
    close = undefined;
    container.remove();
  }
});
