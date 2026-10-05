import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { compile } from "tailwindcss";
import { chooseHeaderAction, openHeaderMenu } from "../../test/header-actions.js";
import { renderApp } from "../../test/harness.js";

const phoneViewport = (initial = true) => {
  const query = Object.assign(new EventTarget(), { matches: initial, media: "(width < 640px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(value => value === query.media ? query : original(value));
  return (narrow: boolean) => act(() => { query.matches = narrow; query.dispatchEvent(new Event("change")); });
};
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens a session drawer, traps focus and restores it after Escape or selecting a session", async () => {
  phoneViewport();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }, { title: "Next task" }] }] });
  expect(screen.queryByRole("navigation", { name: "Sessions" })).toBeNull();
  const trigger = screen.getByRole("button", { name: "Show sessions" });
  await app.user.click(trigger);
  const drawer = screen.getByRole("dialog", { name: "Sessions" });
  expect(within(drawer).getByRole("searchbox", { name: "Filter the sessions" })).toBeDefined();
  expect(document.activeElement).toBe(drawer);
  const buttons = within(drawer).getAllByRole("button");
  buttons.at(-1)?.focus();
  await app.user.tab();
  expect(drawer.contains(document.activeElement)).toBe(true);
  await app.user.click(within(drawer).getByRole("searchbox", { name: "Filter the sessions" }));
  await app.user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
  await app.user.click(trigger);
  await app.user.click(await within(screen.getByRole("dialog", { name: "Sessions" })).findByRole("button", { name: /desk Next task/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  expect(app.shown()?.sessionId).toBe(app.environment("desk").sessionId(1));
  expect(document.activeElement).toBe(trigger);
});

it("keeps desktop pane sizes, drafts and running work when only the focused phone session is visible", async () => {
  const resize = phoneViewport(false);
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }, { title: "Next task" }] }] });
  app.open("desk");
  const firstMessage = await screen.findByRole("textbox", { name: "Message" });
  await app.user.type(firstMessage, "Keep this draft");
  await chooseHeaderAction(app, "Split right");
  app.open("desk", 1);
  await waitFor(() => expect(app.runtime.projections.session(app.environment("desk").environmentId, app.environment("desk").sessionId(1)).read().summary?.title).toBe("Next task"));
  const messages = await screen.findAllByRole("textbox", { name: "Message" });
  const secondMessage = messages.find(message => message !== firstMessage)!;
  act(() => secondMessage.focus());
  await app.user.type(secondMessage, "Another draft", { skipClick: true });
  expect(secondMessage).toHaveProperty("value", "Another draft");
  fireEvent.drop(firstMessage, { dataTransfer: { types: ["Files"], files: [new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "receipt.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "Remove receipt.png" });
  const env = app.environment("desk");
  act(() => env.startRun(env.sessionId(), "Keep running while switching"));
  const held = app.presentation.values.read();
  resize(true);
  expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(secondMessage);
  const menu = await openHeaderMenu(app);
  const split = within(menu).getByRole("menuitem", { name: "Split right" });
  expect(split.getAttribute("aria-disabled")).toBe("true");
  expect(split.textContent).toContain("640px");
  await app.user.keyboard("{Escape}");
  await app.user.click(screen.getByRole("button", { name: "Show sessions" }));
  await app.user.click(await within(screen.getByRole("dialog", { name: "Sessions" })).findByRole("button", { name: /desk First task/ }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(firstMessage);
  expect(firstMessage).toHaveProperty("value", "Keep this draft");
  expect(screen.getByRole("button", { name: "Remove receipt.png" })).toBeDefined();
  expect(app.runtime.projections.session(env.environmentId, env.sessionId()).read().runs.at(-1)?.state).toBe("running");
  resize(false);
  expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(2);
  expect(app.presentation.values.read().paneLayout.rows).toEqual(held.paneLayout.rows);
  expect(app.presentation.values.read().sidebarShown).toBe(held.sidebarShown);
  expect(app.presentation.values.read().sidebarWidth).toBe(held.sidebarWidth);
  expect(secondMessage).toHaveProperty("value", "Another draft");
});

it("opens the existing session actions by tap and sends an organisation command once", async () => {
  phoneViewport();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }] }] });
  await app.user.click(screen.getByRole("button", { name: "Show sessions" }));
  await app.user.click(await screen.findByRole("button", { name: "Actions for “First task”" }));
  const actions = await screen.findByRole("menu", { name: "Organise “First task”" });
  await app.user.click(within(actions).getByRole("menuitem", { name: /Pin/ }));
  await screen.findByRole("region", { name: "Pinned" });
  expect(app.environment("desk").requests("sessions.pin")).toHaveLength(1);
});

it("closes by the drawer close control, an outside tap and selecting the current session", async () => {
  phoneViewport();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }] }] });
  app.open("desk");
  const trigger = screen.getByRole("button", { name: "Show sessions" });
  await app.user.click(trigger);
  await app.user.click(screen.getByRole("button", { name: "Close sessions" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
  await app.user.click(trigger);
  await app.user.click(document.querySelector(".phone-frame-scrim")!);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  await app.user.click(trigger);
  await app.user.click(await within(screen.getByRole("dialog", { name: "Sessions" })).findByRole("button", { name: /desk First task/ }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  expect(document.activeElement).toBe(trigger);
});

it("retains drafts and attachments by session when the drawer replaces the same pane", async () => {
  phoneViewport();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }, { title: "Next task" }] }] });
  app.open("desk");
  const env = app.environment("desk");
  await waitFor(() => expect(app.runtime.projections.session(env.environmentId, env.sessionId()).read().summary?.title).toBe("First task"));
  await app.user.type(await screen.findByRole("textbox", { name: "Message" }), "Keep an unsent draft");
  fireEvent.drop(screen.getByRole("textbox", { name: "Message" }), { dataTransfer: { types: ["Files"], files: [new File([Uint8Array.of(0x89, 0x50, 0x4e, 0x47)], "draft.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "Remove draft.png" });
  const select = async (title: string) => {
    await app.user.click(screen.getByRole("button", { name: "Show sessions" }));
    await app.user.click(await within(screen.getByRole("dialog", { name: "Sessions" })).findByRole("button", { name: new RegExp(`desk ${title}`) }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull());
  };
  await select("Next task");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", ""));
  expect(screen.queryByRole("button", { name: "Remove draft.png" })).toBeNull();
  await select("First task");
  await waitFor(() => expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep an unsent draft"));
  await app.user.click(await screen.findByRole("button", { name: "Remove draft.png" }));
  await select("Next task");
  await select("First task");
  expect(screen.queryByRole("button", { name: "Remove draft.png" })).toBeNull();
});


it("gives the narrow desktop grid a flex column parent within the session card", async () => {
  phoneViewport();
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipt summary" }] }] });
  app.open("desk");
  await screen.findByRole("textbox", { name: "Message" });
  const stylesheet = document.createElement("style");
  stylesheet.textContent = (await compile("@tailwind utilities;")).build(["flex", "flex-col", "flex-1"]);
  document.head.append(stylesheet);
  try {
    const gridParent = screen.getByRole("main").lastElementChild;
    expect(gridParent).not.toBeNull();
    // The grid must participate in its parent's height allocation, not block content sizing.
    expect(getComputedStyle(gridParent!).display).toBe("flex");
    expect(getComputedStyle(gridParent!).flexDirection).toBe("column");
    expect(gridParent?.contains(screen.getByRole("textbox", { name: "Message" }))).toBe(true);
  } finally {
    stylesheet.remove();
  }
});


it.each([[844, 390], [740, 360]])("retains a drawer, draft, active session and live run through portrait / %sx%s / portrait and restores wide panes", async (width, height) => {
  const portrait = Object.assign(new EventTarget(), { matches: false, media: "(width < 640px)", onchange: null, addListener: () => undefined, removeListener: () => undefined });
  const landscape = Object.assign(new EventTarget(), { ...portrait, matches: false, media: "(pointer: coarse) and (hover: none) and (640px <= width <= 960px) and (height <= 500px)" });
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === portrait.media ? portrait : query === landscape.media ? landscape : original(query));
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "First task" }, { title: "Next task" }] }] });
  app.open("desk");
  await screen.findByRole("textbox", { name: "Message" });
  await chooseHeaderAction(app, "Split right");
  app.open("desk", 1);
  const env = app.environment("desk");
  await waitFor(() => expect(app.runtime.projections.session(env.environmentId, env.sessionId(1)).read().summary?.title).toBe("Next task"));
  const fields = await screen.findAllByRole("textbox", { name: "Message" });
  const field = fields[1]!;
  act(() => env.startRun(env.sessionId(1), "Keep running through rotation"));
  await waitFor(() => expect(app.runtime.projections.session(env.environmentId, env.sessionId(1)).read().runs.at(-1)?.state).toBe("running"));
  act(() => field.focus());
  await app.user.type(field, "Keep the rotation draft", { skipClick: true });
  expect(field).toHaveProperty("value", "Keep the rotation draft");
  const held = app.presentation.values.read();
  const active = app.shown();
  const resize = (w: number, h: number, narrow: boolean, shortTouch: boolean) => act(() => {
    vi.stubGlobal("innerWidth", w); vi.stubGlobal("innerHeight", h);
    // MediaQueryList change events reflect layout bounds, never VisualViewport.
    portrait.matches = narrow; landscape.matches = shortTouch;
    portrait.dispatchEvent(new Event("change")); landscape.dispatchEvent(new Event("change")); window.dispatchEvent(new Event("resize"));
  });
  resize(390, 844, true, false);
  await app.user.click(screen.getByRole("button", { name: "Show sessions" }));
  resize(width, height, false, true);
  expect(screen.getAllByRole("region", { name: "Session pane", hidden: true }).filter(pane => !pane.closest("[hidden]"))).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "Sessions" })).toBeDefined();
  resize(390, 844, true, false);
  expect(screen.getByRole("dialog", { name: "Sessions" })).toBeDefined();
  await app.user.click(screen.getByRole("button", { name: "Close sessions" }));
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(field);
  expect(field).toHaveProperty("value", "Keep the rotation draft");
  expect(app.shown()).toEqual(active);
  expect(app.runtime.projections.session(env.environmentId, env.sessionId(1)).read().runs.at(-1)?.state).toBe("running");
  resize(1400, 900, false, false);
  expect(screen.getAllByRole("region", { name: "Session pane" })).toHaveLength(2);
  expect(app.presentation.values.read().paneLayout.rows).toEqual(held.paneLayout.rows);
  expect(app.presentation.values.read().sidebarWidth).toBe(held.sidebarWidth);
  expect(field).toHaveProperty("value", "Keep the rotation draft");
});
