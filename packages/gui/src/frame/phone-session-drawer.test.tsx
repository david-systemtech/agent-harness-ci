// @vitest-environment jsdom-on-node
import { act, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { expect, it, onTestFinished, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { mountGallery } from "../../gallery/mount.js";
import { route } from "../../gallery/scenes/phone-gallery-conversation.js";

it("keeps the session drawer inside the shared web bounds and restores focus without scrolling", async () => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  vi.stubGlobal("visualViewport", viewport);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-drawer-search", "light", {
    "phone-drawer-search": { platform: "web", route, script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: [{ title: "Receipt review" }] }] } },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Show sessions" });
  await user.click(trigger);
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
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)" ? Object.assign(new EventTarget(), { matches: true, media: query }) : original(query));
  onTestFinished(() => vi.restoreAllMocks());
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
