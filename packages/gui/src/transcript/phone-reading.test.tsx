// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, it, onTestFinished, vi } from "vitest";
import * as readingScene from "../../gallery/scenes/phone-transcript-reading.js";
import { mountGallery } from "../../gallery/mount.js";

it.each(["reply", "code"])("keeps native %s selection and reading position through streaming, then explicitly repins", async (kind) => {
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { document.getSelection()?.removeAllRanges(); await gallery.close(); root.remove(); vi.unstubAllGlobals(); });
  await gallery.ready;
  const transcript = screen.getByRole("region", { name: "Transcript" });
  const env = gallery.world.world.environment("desk"), session = env.sessionId();
  const history = env.startRun(session, "Read receipts");
  act(() => {
    env.emit(session, "assistant.text", { runId: history.runId, itemId: "selectable-history", text: "Selectable receipt history.\n\n```text\nreceipt total: 42\n```", aborted: false });
    env.endRun(session, history.runId);
  });
  await within(transcript).findByText("Selectable receipt history.");
  const target = kind === "code" ? transcript.querySelector("pre code")! : within(transcript).getByText("Selectable receipt history.");
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const text = walker.nextNode()!;
  const selection = document.getSelection()!;
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 7);
  let height = 1000, top = 600;
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - 400); } },
  });
  fireEvent.scroll(transcript);
  selection.removeAllRanges(); selection.addRange(range);
  fireEvent(document, new Event("selectionchange"));
  const selected = selection.toString();
  // Selection handles can generate a scroll event even at the current boundary.
  fireEvent.scroll(transcript);
  expect(screen.getByRole("button", { name: "Jump to the latest" })).toBeDefined();
  const next = env.startRun(session, "Stream more receipts");
  height = 1400;
  act(() => env.emit(session, "assistant.delta", { runId: next.runId, itemId: "new-output", fragments: [{ kind: "text", text: "Another receipt arrives. " }] }));
  await waitFor(() => expect(within(transcript).getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toContain("Another receipt arrives."));
  expect(top).toBe(600);
  expect(selection.toString()).toBe(selected);
  expect(selection.anchorNode).toBe(text);
  // Long press and touch scrolling retain their default browser action.
  expect(fireEvent.contextMenu(target)).toBe(true);
  expect(fireEvent.touchMove(transcript)).toBe(true);
  expect(screen.queryByRole("dialog", { name: "Sessions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Jump to the latest" }));
  expect(top).toBe(1000);
  fireEvent.scroll(transcript);
  expect(screen.queryByRole("button", { name: "Jump to the latest" })).toBeNull();
  height = 1800;
  act(() => env.emit(session, "assistant.delta", { runId: next.runId, itemId: "new-output", fragments: [{ kind: "text", text: "Following again. " }] }));
  await waitFor(() => expect(top).toBe(1400));
});

it("suppresses phone root/transcript overscroll while leaving selection, zoom and capped wells native", () => {
  const style = document.createElement("style");
  const source = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  style.textContent = source.slice(source.indexOf("/* Only the mounted phone web frame"));
  const frame = document.createElement("div"); frame.setAttribute("data-web-client", "");
  frame.innerHTML = '<section aria-label="Transcript"><pre><code>wide receipt line</code></pre></section><div data-composer-column></div>';
  document.body.append(frame); document.head.append(style); document.documentElement.setAttribute("data-phone-viewport", "");
  try {
    for (const element of [document.documentElement, document.body, document.getElementById("root")].filter(element => element !== null)) {
      expect(getComputedStyle(element).overflow).toBe("hidden");
      expect(getComputedStyle(element).overscrollBehavior).toBe("none");
    }
    const transcript = frame.querySelector("section")!;
    expect(getComputedStyle(transcript).overscrollBehavior).toBe("none");
    expect(getComputedStyle(transcript).userSelect).toBe("text");
    expect(getComputedStyle(transcript).touchAction).toBe("auto");
    for (const well of [frame.querySelector("pre")!, frame.querySelector("[data-composer-column]")!]) expect(getComputedStyle(well).overscrollBehavior).toBe("contain");
  } finally { document.documentElement.removeAttribute("data-phone-viewport"); frame.remove(); style.remove(); }
});

it("keeps a history anchor and tool choices through disclosure and streaming", async () => {
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "reading", "dark", { reading: { ...readingScene, activate: undefined, readySelector: "pre code" } });
  onTestFinished(async () => { await gallery.close(); root.remove(); vi.unstubAllGlobals(); });
  await gallery.ready;
  const transcript = screen.getByRole("region", { name: "Transcript" });
  let height = 2000, top = 1600;
  Object.defineProperties(transcript, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => 400 },
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = Math.min(value, height - 400); } },
  });
  fireEvent.scroll(transcript); top = 200; fireEvent.scroll(transcript);
  const group = within(transcript).getByRole("button", { name: "Read 2 files" });
  fireEvent.click(group);
  const card = within(transcript).getByRole("group", { name: "Read: reading-open.txt" });
  const toggle = within(card).getByRole("button", { name: "Read: reading-open.txt" });
  fireEvent.click(toggle);
  fireEvent.click(within(card).getByRole("button", { name: "Result" }));
  fireEvent.click(toggle); fireEvent.click(toggle);
  expect(within(card).getByRole("button", { name: "Result" }).getAttribute("aria-expanded")).toBe("true");
  expect(within(transcript).getByRole("button", { name: "Read: reading-closed.txt" }).getAttribute("aria-expanded")).toBe("false");
  const env = gallery.world.world.environment("desk"), session = env.sessionId();
  const { runId } = env.startRun(session, "Another report"); height = 2400;
  act(() => env.emit(session, "assistant.delta", { runId, itemId: "tool-stream", fragments: [{ kind: "text", text: "More totals arrive. " }] }));
  await waitFor(() => expect(within(transcript).getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toContain("More totals arrive."));
  expect(top).toBe(200);
  expect(within(card).getByRole("button", { name: "Result" }).getAttribute("aria-expanded")).toBe("true");
  expect(document.documentElement.scrollTop).toBe(0);
  expect(document.body.scrollTop).toBe(0);
});
