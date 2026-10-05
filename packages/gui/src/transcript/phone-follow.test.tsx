// @vitest-environment jsdom-on-node
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import { mountGallery } from "../../gallery/mount.js";

it("repins on composer focus and keyboard opening, follows scrollport resizing, then respects deliberate reading", async () => {
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
  act(() => { viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
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
});
