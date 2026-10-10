// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";
import { narrowSheet, phoneLayout } from "./phone-layout.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

it.each(["settings-bank-authoring", "setup-authoring", "phone-bank-authoring"])("%s keeps a long question's decisions outside its scrollport", async scene => {
  vi.stubGlobal("innerWidth", scene.startsWith("phone-") ? 390 : 1024);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, scene, "dark"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const request = within(dialog).getByRole("region", { name: "Questions" });
  const decisions = within(dialog).getByRole("group", { name: "Question decision" });
  expect(within(request).getAllByRole("group")).toHaveLength(8);
  expect(within(request).queryByRole("button", { name: "Send answers" })).toBeNull();
  expect(within(decisions).getByRole("button", { name: "Send answers" })).toBeDefined();
  expect(within(dialog).getByRole("textbox", { name: "Message" })).toBeDefined();
  const geometry = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
  const checks = geometry.filter(check => check.hitTestable);
  expect(checks.map(check => check.selector)).toContain('[aria-label="Question decision"] button');
  for (const check of geometry) expect(document.querySelector(check.selector)).not.toBeNull();
  if (scene.startsWith("phone-")) {
    expect(gallery.world.shell).toBeUndefined();
    expect(request.closest("[data-web-client]")).not.toBeNull();
  }
  const user = userEvent.setup();
  await user.click(within(request).getAllByRole("radio", { name: "Working agreements" })[0]!);
  await user.click(within(decisions).getByRole("button", { name: "Send answers" }));
  expect(await within(dialog).findByRole("article", { name: "Question" })).toBeDefined();
});

it("keeps authoring in the dialog flow when shared phone styles load after the dialog styles", async () => {
  vi.stubGlobal("innerWidth", 390);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-bank-authoring", "dark"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const sheets: HTMLStyleElement[] = [];
  const append = (css: string) => {
    const style = document.createElement("style"); style.textContent = css; document.head.append(style); sheets.push(style); return style;
  };
  try {
    document.documentElement.setAttribute("data-phone-viewport", "");
    append(readFileSync(new URL("../src/setup/authoring-conversation.css", import.meta.url), "utf8"));
    const shared = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    append(shared.slice(shared.indexOf("[data-web-client] {")));
    append(readFileSync(new URL("../src/composer/phone-conversation.css", import.meta.url), "utf8"));
    const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
    expect(getComputedStyle(dialog.querySelector("[data-authoring-frame]")!).position).toBe("static");
    const column = within(dialog).getByRole("textbox", { name: "Message" }).closest("[data-composer-column]")!;
    expect(getComputedStyle(column).flexShrink).toBe("0");
    expect(getComputedStyle(column).maxHeight).toBe("none");
    expect(getComputedStyle(dialog.querySelector('[aria-label="Parked prompt"]')!).maxHeight).toBe("min(60dvh, var(--session-prompt-height, 60dvh))");
    expect(getComputedStyle(column).getPropertyValue("--session-prompt-height")).toBe("");
  } finally { document.documentElement.removeAttribute("data-phone-viewport"); sheets.forEach(sheet => sheet.remove()); }
});

it.each([844, 480])("a 390×%s phone restores the authoring sheet from its own header without covering the transcript", async height => {
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", height);
  phoneLayout();
  narrowSheet();
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-bank-authoring", "dark"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "/documents{Enter}");
  expect(await within(dialog).findByRole("dialog", { name: "Side column" })).toBeDefined();
  await user.click(within(dialog).getByRole("button", { name: "Close side sheet" }));
  const restore = within(dialog).getByRole("button", { name: "Show the side column" });
  expect(restore.closest("[data-authoring-header]")).not.toBeNull();
  expect(restore.classList.contains("absolute")).toBe(false);
  expect(document.activeElement).toBe(restore);
  expect(within(dialog).queryByRole("dialog", { name: "Side column" })).toBeNull();
  expect(within(dialog).getByRole("region", { name: "Transcript" }).contains(restore)).toBe(false);
  expect(dialog.querySelectorAll("[data-dock-reopen]")).toHaveLength(1);
  const style = document.createElement("style");
  style.textContent = readFileSync(new URL("../src/side-column/side-column.css", import.meta.url), "utf8");
  document.head.append(style);
  try {
    expect(getComputedStyle(restore).width).toBe("44px");
    expect(getComputedStyle(restore).height).toBe("44px");
  } finally { style.remove(); }
  await user.click(restore);
  expect(within(dialog).getByRole("dialog", { name: "Side column" })).toBeDefined();
  expect(within(dialog).getByRole("region", { name: "Documents" })).toBeDefined();
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close side sheet" }));
  expect(within(dialog).queryByRole("button", { name: "Show the side column" })).toBeNull();
});

it("keeps a narrow desktop authoring pane's restore handle at its edge", async () => {
  narrowSheet();
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "settings-bank-authoring", "dark"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const user = userEvent.setup();
  await user.type(within(dialog).getByRole("textbox", { name: "Message" }), "/documents{Enter}");
  await user.click(await within(dialog).findByRole("button", { name: "Close side sheet" }));
  const restore = within(dialog).getByRole("button", { name: "Show the side column" });
  expect(restore.closest("[data-authoring-header]")).toBeNull();
  expect(restore.closest("[data-dock-owner]")).not.toBeNull();
  expect(restore.classList.contains("absolute")).toBe(true);
  expect(document.activeElement).toBe(restore);
  await user.click(restore);
  expect(within(dialog).getByRole("region", { name: "Documents" })).toBeDefined();
});

it("bounds the authoring header's status row so its whole groups can wrap", async () => {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "settings-bank-authoring", "dark"); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const line = within(dialog).getByRole("region", { name: "Status line" });
  const sheet = document.createElement("style");
  sheet.textContent = readFileSync(new URL("../src/setup/authoring-conversation.css", import.meta.url), "utf8");
  document.head.append(sheet);
  try {
    const style = getComputedStyle(line);
    expect(style.minWidth).toBe("0px");
    expect(style.flexBasis).toBe("100%");
    expect(style.width).toBe("100%");
  } finally { sheet.remove(); }
});

it.each(["light", "dark"] as const)("the %s authoring usage scene measures every group and keeps the conversation available", async ladder => {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "settings-bank-authoring-usage", ladder); close = gallery.close;
  expect(await gallery.ready).toBe(true);
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const line = within(dialog).getByRole("region", { name: "Status line" });
  expect(within(line).getAllByRole("img").map(ring => ring.getAttribute("aria-label"))).toEqual([
    "Context: 80%", "5-hour 42%", "Weekly 80%", "Weekly, Fable 95%", "Extra usage 30%",
  ]);
  const geometry = JSON.parse(root.dataset["galleryGeometry"] ?? "[]") as SceneGeometry[];
  const checked = geometry.filter(check => check.visibleWithin === "[data-authoring-dialog]")
    .flatMap(check => Array.from(document.querySelectorAll(check.selector)));
  for (const child of [...line.children, ...line.querySelectorAll("button, svg[role=img], [data-status-chip]")]) expect(checked).toContain(child);
  for (const reading of line.querySelectorAll('[aria-label="Usage details"] > span > span')) {
    expect(geometry.some(check => check.contentFits && reading.matches(check.selector))).toBe(true);
  }
  expect(within(dialog).getByRole("heading", { name: "Describe project-memory" })).toBeDefined();
  expect(within(dialog).getByRole("region", { name: "Transcript" })).toBeDefined();
  expect(within(dialog).getByRole("textbox", { name: "Message" })).toBeDefined();
  for (const check of geometry) expect(document.querySelector(check.selector)).not.toBeNull();
});
