// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { mountGallery } from "../../gallery/mount.js";
import { routineFixture } from "../../gallery/routine-fixtures.js";
import { phoneLayoutMedia } from "./phone-frame.js";
import { route } from "../../gallery/scenes/phone-gallery-conversation.js";

it("keeps the session drawer inside the shared web bounds and restores focus without scrolling", async () => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", viewport);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-drawer-search", "light", {
    "phone-drawer-search": { platform: "web", route, script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Receipt review" }] }] } },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Show sessions" });
  screen.getByRole("textbox", { name: "Message" }).focus();
  // Touch browsers can activate a button without focusing it first.
  fireEvent.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Sessions" });
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  expect(drawer.closest("[data-web-client]")).toBe(frame);
  expect(document.activeElement).toBe(drawer);
  await user.click(within(drawer).getByRole("searchbox", { name: "Filter the sessions" }));
  act(() => { viewport.height = 480; viewport.offsetTop = 120; viewport.dispatchEvent(new Event("resize")); });
  expect(frame.style.height).toBe("480px");
  expect(frame.style.top).toBe("120px");
  const focus = vi.spyOn(trigger, "focus");
  await user.click(within(drawer).getByRole("button", { name: "Close sessions" }));
  expect(document.activeElement).toBe(trigger);
  expect(focus).toHaveBeenCalledWith({ preventScroll: true });
});

it("searches and switches sessions while retaining both drafts and running work", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipt review" }, { title: "Receipt follow-up" }, { title: "Other work" }] }] });
  app.open("desk");
  const env = app.environment("desk");
  await app.user.type(await screen.findByRole("textbox", { name: "Message" }), "First unsent draft");
  act(() => env.startRun(env.sessionId(), "Continue the receipt review"));
  const select = async (title: string) => {
    const trigger = screen.getByRole("button", { name: "Show sessions" });
    await app.user.click(trigger);
    const drawer = screen.getByRole("dialog", { name: "Sessions" });
    expect(document.activeElement).toBe(drawer);
    const filter = within(drawer).getByRole("searchbox", { name: "Filter the sessions" });
    await app.user.clear(filter);
    await app.user.type(filter, "Receipt");
    const results = await within(drawer).findByRole("list", { name: "Sessions matching “Receipt”" });
    expect(within(results).queryByRole("button", { name: /desk Other work/ })).toBeNull();
    expect(within(results).getByRole("button", { name: /desk Receipt review Running/ })).toBeDefined();
    await app.user.click(within(results).getByRole("button", { name: new RegExp(`desk ${title}`) }));
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  };
  await select("Receipt follow-up");
  await app.user.type(await screen.findByRole("textbox", { name: "Message" }), "Second unsent draft");
  await select("Receipt review");
  expect(await screen.findByRole("textbox", { name: "Message" })).toHaveProperty("value", "First unsent draft");
  expect(app.runtime.projections.session(env.environmentId, env.sessionId()).read().runs.at(-1)?.state).toBe("running");
  await select("Receipt follow-up");
  expect(await screen.findByRole("textbox", { name: "Message" })).toHaveProperty("value", "Second unsent draft");
  expect(env.requests("runs.cancel")).toHaveLength(0);
});

it("closes the drawer on either New session control and gives the new session's composer the focus", async () => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipt review" }] }] });
  app.open("desk");
  await screen.findByRole("textbox", { name: "Message" });
  const startFromDrawer = async (control: (drawer: HTMLElement) => HTMLElement) => {
    const trigger = screen.getByRole("button", { name: "Show sessions" });
    await app.user.click(trigger);
    await app.user.click(control(screen.getByRole("dialog", { name: "Sessions" })));
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
    // Radix hands focus back once the drawer has unmounted, a macrotask later.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)));
    const surface = screen.getByRole("region", { name: "New session" });
    expect(document.activeElement).toBe(within(surface).getByRole("textbox", { name: "Message" }));
  };
  await startFromDrawer(drawer => within(drawer).getByRole("button", { name: "New session" }));
  await startFromDrawer(drawer => within(drawer).getByRole("button", { name: "New session on desk" }));
  await app.user.click(screen.getByRole("button", { name: "Show sessions" }));
  await app.user.click(within(screen.getByRole("dialog", { name: "Sessions" })).getByRole("button", { name: /desk Receipt review/ }));
  expect(screen.queryByRole("region", { name: "New session" })).toBeNull();
});

it("keeps the desktop sidebar shown on its New session control", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipt review" }] }] });
  app.open("desk");
  const sidebar = await screen.findByRole("navigation", { name: "Sessions" });
  await app.user.click(within(sidebar).getByRole("button", { name: "New session" }));
  const surface = await screen.findByRole("region", { name: "New session" });
  expect(document.activeElement).toBe(within(surface).getByRole("textbox", { name: "Message" }));
  expect(screen.getByRole("navigation", { name: "Sessions" })).toBe(sidebar);
  expect(screen.queryByRole("button", { name: "Show sessions" })).toBeNull();
});

it("keeps a session row usable while the landscape drawer footer scrolls independently", async () => {
  vi.stubGlobal("innerWidth", 844); vi.stubGlobal("innerHeight", 390);
  vi.stubGlobal("matchMedia", (query: string) => Object.assign(new EventTarget(), { matches: query.includes("pointer: coarse"), media: query, onchange: null }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "landscape-drawer-controls", "light", {
    "landscape-drawer-controls": { platform: "web", route, script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Receipt review" }] }] },
      arrangeWeb: world => world.environment("desk").wire.answer("routines.list", () => ({ result: { routines: Array.from({ length: 4 }, (_, index) => routineFixture(`Receipt check ${index + 1}`, index + 1)) } })),
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
  const drawer = screen.getByRole("dialog", { name: "Sessions" });
  const scheduled = await within(drawer).findByRole("region", { name: "Scheduled" });
  expect(await within(scheduled).findByRole("button", { name: /Receipt check 4/ })).toBeDefined();
  expect(scheduled.closest("[data-sidebar-scroll]")).toBe(drawer.querySelector("[data-sidebar-scroll]"));
  const stylesheet = document.createElement("style");
  stylesheet.textContent = readFileSync(new URL("./phone-frame.css", import.meta.url), "utf8");
  document.head.append(stylesheet);
  try {
    const media = Array.from(stylesheet.sheet?.cssRules ?? []).find((rule): rule is CSSMediaRule => "conditionText" in rule);
    expect(media?.conditionText).toBe(phoneLayoutMedia()[1]?.media);
    // Activate the shipped landscape rules: jsdom cannot evaluate layout media.
    stylesheet.textContent = Array.from(media?.cssRules ?? []).map(rule => rule.cssText).join("\n");
    expect(getComputedStyle(drawer.querySelector("[data-sidebar-scroll]")!).minHeight).toBe("56px");
    const create = within(drawer).getByRole("button", { name: "New session" }).parentElement!;
    const filter = within(drawer).getByRole("searchbox", { name: "Filter the sessions" }).parentElement!.parentElement!;
    expect(getComputedStyle(create).paddingBlock).toBe("4px");
    expect(getComputedStyle(filter).paddingBlock).toBe("4px");
    const footer = within(drawer).getByRole("button", { name: "Restore a deleted session…" }).closest("div")!;
    expect(getComputedStyle(footer).minHeight).toBe("48px");
    expect(getComputedStyle(footer).flexShrink).toBe("1");
    expect(getComputedStyle(footer).overflowY).toBe("auto");
    fireEvent.click(within(drawer).getByRole("button", { name: "Close sessions" }));
    expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
  } finally { stylesheet.remove(); }
});
