// @vitest-environment jsdom-on-node
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

beforeEach(() => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => query === "(width < 640px)"
    ? Object.defineProperty(Object.assign(new EventTarget(), { media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }), "matches", { get: () => window.innerWidth < 640 }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
});

it.each([[false, 844], [true, 844], [false, 780], [true, 780]] as const)("repins on focus/open and after gradual close/reopen with layout resize %s and unoccluded height %s", async (resizeLayout, unoccludedHeight) => {
  const callbacks = new Map<Element, () => void>();
  vi.stubGlobal("ResizeObserver", class {
    constructor(private readonly callback: () => void) {}
    observe(element: Element) { callbacks.set(element, this.callback); }
    disconnect() { for (const [element, callback] of callbacks) if (callback === this.callback) callbacks.delete(element); }
  });
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.unstubAllGlobals(); });
  await gallery.ready;
  act(() => { window.innerHeight = unoccludedHeight; viewport.height = unoccludedHeight; viewport.dispatchEvent(new Event("resize")); });
  const transcript = screen.getByRole("region", { name: "Transcript" });
  let height = 1000, visible = 400, top = 600;
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => visible },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - visible); } },
  });
  expect(callbacks.has(transcript)).toBe(true);
  visible = 200;
  act(() => callbacks.get(transcript)!());
  expect(top).toBe(800);
  top = 300; fireEvent.scroll(transcript);
  expect(screen.getByRole("button", { name: "Jump to the latest" })).toBeDefined();
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  expect(top).toBe(800);
  top = 300; fireEvent.scroll(transcript);
  visible = 100;
  act(() => { if (resizeLayout) window.innerHeight = 480; viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  expect(top).toBe(900);
  const env = gallery.world.world.environment("desk");
  const { runId } = env.startRun(env.sessionId(), "Check more receipts");
  height = 1400;
  act(() => env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "phone-reply", fragments: [{ kind: "text", text: "First line. " }] }));
  await screen.findByText("First line.", { exact: false });
  await waitFor(() => expect(top).toBe(1300));
  top = 300; fireEvent.scroll(transcript);
  height = 1800;
  act(() => env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "phone-reply", fragments: [{ kind: "text", text: "Second line. " }] }));
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toContain("Second line."));
  visible = 150;
  act(() => callbacks.get(transcript)!());
  act(() => { viewport.offsetTop = 120; viewport.dispatchEvent(new Event("scroll")); });
  expect(top).toBe(300);
  act(() => { viewport.height = 450; viewport.dispatchEvent(new Event("resize")); });
  expect(top).toBe(300);
  fireEvent.click(screen.getByRole("button", { name: "Jump to the latest" }));
  expect(top).toBe(1650);
  const message = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(message, { target: { value: "Keep this draft" } });
  act(() => { window.innerHeight = unoccludedHeight; viewport.height = unoccludedHeight; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(false);
  expect(document.activeElement).toBe(message);
  expect(message).toHaveProperty("value", "Keep this draft");
  act(() => { if (resizeLayout) window.innerHeight = 480; viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  for (const height of [510, 540, 570, 600, 630, 660, 690, 720, 750, 780, 810, unoccludedHeight].filter(height => height <= unoccludedHeight)) {
    act(() => { if (resizeLayout) window.innerHeight = height; viewport.height = height; viewport.dispatchEvent(new Event("resize")); });
  }
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(false);
  expect(document.activeElement).toBe(message);
  top = 300; fireEvent.scroll(transcript);
  expect(screen.getByRole("button", { name: "Jump to the latest" })).toBeDefined();
  act(() => { if (resizeLayout) window.innerHeight = 480; viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  expect(top).toBe(1650);
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(true);
});

it("keeps a hidden phone pane at its reading position when another composer focuses and opens the keyboard", async () => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined })
    : original(query));
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-frame-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  await gallery.ready;
  const env = gallery.world.world.environment("desk");
  act(() => gallery.world.presentation.set("paneLayout", { focused: "first", rows: [{ id: "row", height: 100, panes: [
    { id: "first", width: 50, session: { environmentId: env.environmentId, sessionId: env.sessionId() } },
    { id: "second", width: 50, session: { environmentId: env.environmentId, sessionId: env.sessionId(1) } },
  ] }] }));
  await waitFor(() => expect(screen.getAllByRole("region", { name: "Transcript", hidden: true })).toHaveLength(2));
  const transcripts = screen.getAllByRole("region", { name: "Transcript", hidden: true });
  const visible = screen.getByRole("region", { name: "Transcript" });
  const hidden = transcripts.find(transcript => transcript !== visible)!;
  const positions = new Map(transcripts.map(transcript => [transcript, 600]));
  for (const transcript of transcripts) {
    Object.defineProperties(transcript, {
      scrollHeight: { configurable: true, get: () => 1000 },
      clientHeight: { configurable: true, get: () => 400 },
      scrollTop: { configurable: true, get: () => positions.get(transcript), set: (value: number) => { positions.set(transcript, Math.min(value, 600)); } },
    });
    fireEvent.scroll(transcript);
    positions.set(transcript, 300); fireEvent.scroll(transcript);
  }
  expect(within(hidden.parentElement!).getByText("Jump to the latest")).toBeDefined();
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  expect(positions.get(visible)).toBe(600);
  expect(positions.get(hidden)).toBe(300);
  positions.set(visible, 300); fireEvent.scroll(visible);
  act(() => { viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  expect(positions.get(visible)).toBe(600);
  expect(positions.get(hidden)).toBe(300);
  expect(within(hidden.parentElement!).getByText("Jump to the latest")).toBeDefined();
});

it.each([false, true])("preserves reading during bars resizing after a focused keyboard close, then repins on reopening with layout resize %s", async (resizeLayout) => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.unstubAllGlobals(); });
  await gallery.ready;
  const transcript = screen.getByRole("region", { name: "Transcript" });
  const message = screen.getByRole("textbox", { name: "Message" });
  let visible = 400, top = 600;
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => 1000 },
    clientHeight: { configurable: true, get: () => visible },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, 1000 - visible); } },
  });
  fireEvent.scroll(transcript);
  act(() => message.focus());
  fireEvent.change(message, { target: { value: "Keep this draft" } });
  act(() => { if (resizeLayout) window.innerHeight = 480; viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  act(() => { window.innerHeight = 844; viewport.height = 844; viewport.dispatchEvent(new Event("resize")); });
  expect(document.activeElement).toBe(message);
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(false);
  top = 300; fireEvent.scroll(transcript);
  act(() => { window.innerHeight = 780; viewport.height = 780; viewport.dispatchEvent(new Event("resize")); });
  expect(top).toBe(300);
  expect(screen.getByRole("button", { name: "Jump to the latest" })).toBeDefined();
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(false);
  visible = 100;
  for (const height of [750, 720, 690, 660, 630, 600, 570, 540, 510, 480]) {
    act(() => { if (resizeLayout) window.innerHeight = height; viewport.height = height; viewport.dispatchEvent(new Event("resize")); });
  }
  expect(top).toBe(900);
  expect(screen.queryByRole("button", { name: "Jump to the latest" })).toBeNull();
  act(() => { window.innerHeight = 780; viewport.height = 780; viewport.dispatchEvent(new Event("resize")); });
  expect(root.querySelector("[data-web-client]")?.hasAttribute("data-phone-composing")).toBe(false);
  expect(document.activeElement).toBe(message);
  expect(message).toHaveProperty("value", "Keep this draft");
});
