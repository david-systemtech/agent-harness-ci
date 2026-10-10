import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { measureSceneGeometry } from "../gallery/geometry.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";
import { mountGallery } from "../gallery/mount.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["light", "dark"] as const)("draws Settings bank records and their measured cards in %s", async (ladder) => {
  vi.stubGlobal("innerWidth", 1400);
  vi.stubGlobal("innerHeight", 900);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-banks", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-banks"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const bank = within(dialog).getByRole("region", { name: "project-memory" });
  expect(within(bank).getByRole("button", { name: "Move to your forge" })).toBeDefined();
  expect(within(bank).getByRole("button", { name: "Describe it" })).toBeDefined();
  expect(within(dialog).getByRole("button", { name: "Open the review" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: "[data-settings-dialog]", width: 1352, height: 852 },
    { selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 },
  ]));
});

it("draws a team bank whose landing, refused for want of a forge account, the covering account cleared, with no failure on its card", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "settings-bank-landing-cleared", "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("settings-bank-landing-cleared"));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const bank = within(dialog).getByRole("region", { name: "team-memory" });
  expect(within(bank).getByText("On git.example.test")).toBeDefined();
  expect(within(bank).queryByRole("alert")).toBeNull();
  expect(within(bank).queryByText(/found none/)).toBeNull();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([{ selector: "[data-bank-card]", paddingLeft: 16, paddingTop: 16 }]));
});

it.each(["light", "dark"] as const)("draws the setup choices with navigation outside scrolling content in %s", async (ladder) => {
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-memory-bank", ladder);
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-memory-bank"));
  const card = await screen.findByRole("region", { name: "Memory bank" });
  expect(within(card).getByText("No notebook yet. Optional.")).toBeDefined();
  expect(within(card).getByRole("radiogroup", { name: "What would you like?" })).toBeDefined();
  expect(within(card).getByText("Forge: member on git.example.test")).toBeDefined();
  expect(within(card).getByRole("textbox", { name: "Name" })).toBeDefined();
  const footer = screen.getByRole("navigation", { name: "Step navigation" });
  expect(container.querySelector("[data-setup-scroll]")?.contains(footer)).toBe(false);
  expect(within(footer).getByRole("button", { name: "Continue" })).toBeDefined();
  expect(JSON.parse(container.dataset["galleryGeometry"] ?? "[]")).toEqual(expect.arrayContaining([
    { selector: 'nav[aria-label="Set up steps"]', width: 280 },
    { selector: "[data-bank-content]", maxWidth: 620 },
    { selector: 'footer[aria-label="Step navigation"]', height: 67 },
  ]));
});

// Replay the hosted capture's field cap and input height; jsdom has no Tailwind layout.
it("measures the setup field wrappers rather than uncapped inputs", async () => {
  const container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  const gallery = await mountGallery(container, "setup-memory-bank", "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe("setup-memory-bank"));
  const checks = (JSON.parse(container.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[])
    .filter((check) => check.selector.startsWith("[data-bank-form]") && check.paddingLeft === undefined);
  container.dataset["galleryGeometry"] = JSON.stringify(checks);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => ({
    maxWidth: element.classList.contains("max-w-[224px]") ? "224px" : "none",
  }) as CSSStyleDeclaration);
  for (const input of container.querySelectorAll("[data-bank-form] input")) {
    vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 32));
  }
  expect(measureSceneGeometry()).toEqual([]);
});

/** The Set up Memory bank scene `name`, mounted at 1400x900 once ready, its card. */
const setupBankScene = async (name: string) => {
  vi.stubGlobal("innerWidth", 1400);
  vi.stubGlobal("innerHeight", 900);
  const container = document.createElement("div");
  document.body.append(container);
  const gallery = await mountGallery(container, name, "dark");
  close = gallery.close;
  expect(await gallery.ready).toBe(true);
  await waitFor(() => expect(container.dataset["galleryReady"]).toBe(name));
  return screen.findByRole("region", { name: "Memory bank" });
};

// setup-copy.md §5.8's states for the gallery (#1853): no forge, the form's empty field, describing, joined.
it("draws the Memory bank step with no forge yet: the row says so with Go to Forges, and Create stays enabled", async () => {
  const card = await setupBankScene("setup-memory-bank-no-forge");
  expect(within(card).getByText("No forge yet.")).toBeDefined();
  expect(within(card).getByRole("button", { name: "Go to Forges" })).toBeDefined();
  expect(within(card).getByRole("button", { name: "Create notebook" }).hasAttribute("disabled")).toBe(false);
  expect(within(card).getByRole("button", { name: "Keep it on this computer for now" })).toBeDefined();
});

it("draws the Memory bank form after Create notebook was pressed with the Name empty", async () => {
  const card = await setupBankScene("setup-memory-bank-form-empty");
  expect(within(card).getByRole("alert").textContent).toBe("Error: Enter a name.");
  expect(within(card).getByRole("textbox", { name: "Name" }).getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(within(card).getByRole("textbox", { name: "Name" }));
});

it("draws a notebook just created, with what Describe it does beside it", async () => {
  const card = await setupBankScene("setup-memory-bank-describing");
  const notebook = within(card).getByRole("region", { name: "project-memory" });
  expect(within(notebook).getByText("Now describe your notebook. An agent asks a few questions and writes the description.")).toBeDefined();
  expect(within(notebook).getByRole("button", { name: "Describe it" })).toBeDefined();
  expect(within(notebook).getByText("Description: missing")).toBeDefined();
});

it("draws a joined team notebook with its badges in words", async () => {
  const card = await setupBankScene("setup-memory-bank-joined");
  const notebook = within(card).getByRole("region", { name: "team-memory" });
  expect([...notebook.querySelectorAll("[data-bank-badge]")].map((badge) => badge.textContent)).toEqual(["Team", "On", "On git.example.test", "Description: ready"]);
});
