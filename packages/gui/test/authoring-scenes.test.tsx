// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { mountGallery } from "../gallery/mount.js";
import type { SceneGeometry } from "../gallery/scene-registry.js";

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
    expect(getComputedStyle(dialog.querySelector('[aria-label="Parked prompt"]')!).maxHeight).toBe("60dvh");
  } finally { document.documentElement.removeAttribute("data-phone-viewport"); sheets.forEach(sheet => sheet.remove()); }
});
