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

it.each(["light", "dark"] as const)("shows six bounded setup regions in %s", async (ladder) => {
  for (const name of ["setup-browser", "setup-carry-over", "setup-carry-over-nothing", "setup-carry-over-after", "setup-bank-preview", "setup-authoring"]) {
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
      for (const heading of ["Copy this folder location.", "Choose the agent-harness extension's icon, then Options, and type this code:", "Sites you are building"]) {
        expect(screen.getByRole("heading", { name: heading })).toBeDefined();
      }
      expect(within(screen.getByRole("region", { name: "Browser" })).queryAllByRole("checkbox")).toHaveLength(0);
      expect(screen.getByRole("img", { name: "Step 5: done" })).toBeDefined();
      expect(screen.getByText("Agents now use your Chrome.")).toBeDefined();
    }
    if (name === "setup-carry-over") {
      expect(screen.getByText("Project has past chats to bring over. Choose Bring them over.")).toBeDefined();
      expect(screen.queryByText("Everything is already here.")).toBeNull();
      expect(screen.getByText("Project: 24 past chats, 7 notes folders, 7 skills.")).toBeDefined();
      expect(screen.getByRole("button", { name: "Bring them over" })).toBeDefined();
      expect(screen.getByRole("button", { name: "What will come over" })).toBeDefined();
      expect(screen.getByRole("button", { name: "What will not come over" })).toBeDefined();
    }
    if (name === "setup-carry-over-nothing") {
      expect(screen.getByText("Nothing to bring over from this computer.")).toBeDefined();
      expect(screen.getByText("You can continue.")).toBeDefined();
    }
    if (name === "setup-carry-over-after") {
      expect(screen.getByText("1 item from Project did not come over. Choose Try again.")).toBeDefined();
      expect(screen.queryByText("Everything is already here.")).toBeNull();
      const after = within(screen.getByRole("region", { name: "What came over" }));
      expect(after.getByText("Brought over 23 chats and 1 notes folder.")).toBeDefined();
      expect(after.getByText("1 item from Project did not come over.")).toBeDefined();
      expect(after.getByText("Your skills now live in agent-harness. Edit them there.")).toBeDefined();
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
