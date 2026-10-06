// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { mountGallery } from "../../gallery/mount.js";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { renderApp } from "../../test/harness.js";
import { composerControlExpression } from "../../scripts/phone-refusal-smoke.js";
import { filledKeyboardPrompt } from "../../gallery/scenes/phone-keyboard-dock.js";
import { route } from "../../gallery/scenes/phone-gallery-conversation.js";

beforeEach(() => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => query === "(width < 640px)"
    ? Object.defineProperty(Object.assign(new EventTarget(), { media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }), "matches", { get: () => window.innerWidth < 640 }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
});

it("keeps the composing draft until the input method commits, including an Enter without isComposing", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  const field = await screen.findByRole("textbox", { name: "Message" });
  act(() => field.focus());
  fireEvent.compositionStart(field);
  fireEvent.change(field, { target: { value: "確認" } });
  fireEvent.keyDown(field, { key: "Enter", code: "Enter", isComposing: false, keyCode: 229 });
  expect(app.environment("desk").requests("runs.start")).toHaveLength(0);
  expect(field).toHaveProperty("value", "確認");
  fireEvent.compositionEnd(field);
  await app.user.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(app.environment("desk").requests("runs.start")).toHaveLength(1));
});

it("resizes the message after width delivery without resizing it inside the observer cycle", async () => {
  const Original = globalThis.ResizeObserver;
  let deliver!: (width: number) => void;
  vi.stubGlobal("ResizeObserver", class extends Original {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.callback = callback;
    }
    private readonly callback: ResizeObserverCallback;
    override observe(target: Element) {
      if (target.getAttribute("aria-label") !== "Message") return super.observe(target);
      deliver = width => this.callback([{ target, contentRect: new DOMRect(0, 0, width, 44), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }], this);
    }
  });
  onTestFinished(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  const field = await screen.findByRole("textbox", { name: "Message" });
  const frames = new Map<number, FrameRequestCallback>(); let next = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++next, callback); return next; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.spyOn(field, "scrollHeight", "get").mockReturnValue(96);
  const height = field.style.height;
  act(() => deliver(318));
  expect(field.style.height).toBe(height);
  act(() => deliver(288));
  expect(field.style.height).toBe(height);
  act(() => { const draw = [...frames.values()]; frames.clear(); draw.forEach(callback => callback(0)); });
  expect(field.style.height).toBe("96px");
  vi.spyOn(field, "scrollHeight", "get").mockReturnValue(120);
  act(() => deliver(288));
  act(() => { const draw = [...frames.values()]; frames.clear(); draw.forEach(callback => callback(0)); });
  expect(field.style.height).toBe("96px");
  act(() => deliver(302));
  app.view.unmount();
  act(() => { const draw = [...frames.values()]; frames.clear(); draw.forEach(callback => callback(0)); });
  expect(field.style.height).toBe("96px");
});

it("fits the web conversation to the visual viewport and leaves pinch zoom alone", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 480, width: 390, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerWidth", 390);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root";
  document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
  viewport.height = 400;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
  viewport.scale = 2;
  viewport.height = 200;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
  await gallery.close();
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("");
});

it("fits a missing-workspace conversation before and after its message field returns", async () => {
  vi.stubGlobal("innerWidth", 390);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: true, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); });
  const viewport = Object.assign(new EventTarget(), { height: 480, width: 390, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerWidth", 390);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-missing-workspace", "light", {
    "phone-missing-workspace": {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], sessions: Array.from({ length: 1 }, () => ({ title: "Receipts", workspaceMissingSince: "2026-01-01T00:00:00Z" })) }] },
      readySelector: '[aria-label="The workspace is gone"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  expect(screen.queryByRole("textbox", { name: "Message" })).toBeNull();
  expect(screen.queryByRole("region", { name: "Workspace check" })).toBeNull();
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
  const env = gallery.world.world.environment("desk");
  await act(async () => {
    await gallery.world.runtime.commands.dispatch(env.environmentId, "sessions.setWorkspace", { sessionId: env.sessionId(), workspace: { kind: "directory", path: "/work/receipts" } });
  });
  await screen.findByRole("textbox", { name: "Message" });
  expect(screen.getByRole("button", { name: /^Workspace check:/ })).toBeDefined();
  viewport.height = 400;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("400px");
});

it("opens the phone run settings by tap without taking space from the waiting card initially", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-permission");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const toggle = screen.getByRole("button", { name: "Run settings" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByRole("button", { name: "Allow once" })).toBeDefined();
});

it("answers a phone prompt once after the connection drops with its answer in flight", async () => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-permission");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const env = gallery.world.world.environment("desk");
  env.holdAnswers(true);
  fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
  await waitFor(() => expect(env.requests("permissions.prompts.answer")).toHaveLength(1));
  const commandId = env.requests("permissions.prompts.answer")[0]!.params["commandId"];
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  env.holdAnswers(false);
  act(() => env.server.drop());
  await screen.findByText("Locked: desk cannot be reached.");
  await act(async () => gallery.world.clock.advance(2_000));
  await waitFor(() => expect(env.answered()).toHaveLength(1));
  expect(env.requests("permissions.prompts.answer").every(request => request.params["commandId"] === commandId)).toBe(true);
  expect(screen.queryByRole("region", { name: "Parked prompt" })).toBeNull();
});

it.each(["long", "question", "plan"])("mounts the phone-conversation-%s surface with measurable touch and keyboard actions", async kind => {
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, `phone-conversation-${kind}`, "light", undefined, { platform: "web", textSize: 20 });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  expect(gallery.world.shell).toBeUndefined();
  const decision = kind === "plan" ? "Approve · continue in acceptEdits" : kind === "question" ? "Send answer" : "Send";
  expect(screen.getByRole("button", { name: decision })).toBeDefined();
  if (kind === "long") {
    expect(screen.getByRole("list", { name: "Attachments" }).textContent).toContain("unusually-long-receipt-filename-for-the-quarter.txt");
    expect(screen.getAllByRole("button", { name: /^Remove unusually-long-receipt-filename/ })).toHaveLength(20);
    expect(screen.getByRole("region", { name: "Queued messages" }).textContent).toContain("1 message queued");
    await waitFor(() => expect([...root.querySelectorAll("[data-tool-raw]")].map(element => element.textContent).join("\n")).toContain("All receipt totals match."));
  }
  if (kind === "question") {
    const own = screen.getByRole("textbox", { name: "Your own answer" });
    act(() => own.focus());
    fireEvent.compositionStart(own);
    fireEvent.change(own, { target: { value: "確認" } });
    fireEvent.keyDown(own, { key: "Enter", code: "Enter", ctrlKey: true, keyCode: 229 });
    expect(gallery.world.world.environment("desk").requests("permissions.prompts.answer")).toHaveLength(0);
    fireEvent.compositionEnd(own);
    fireEvent.click(screen.getByRole("button", { name: decision }));
    await waitFor(() => expect(gallery.world.world.environment("desk").answered()).toHaveLength(1));
  }
  const geometry = JSON.parse(root.dataset["galleryGeometry"]!);
  expect(geometry).toContainEqual({ selector: "[data-web-client]", contentFits: true });
  expect(geometry).toContainEqual({ selector: '[aria-label="Transcript"]', minimumHeight: 44, visibleWithin: "[data-web-client]" });
  expect(geometry).toContainEqual({ selector: '[aria-label="Message"]', minimumHeight: 44, visibleWithin: "[data-web-client]" });
});

it("lets a phone user scroll the refused draft, remedy and Run settings in the composer region", async () => {
  vi.stubGlobal("innerWidth", 390);
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const refusal = "The account personal is not signed in on this environment, so no run can start. Sign in in Settings, Accounts.";
  const gallery = await mountGallery(root, "phone-refusal", "dark", {
    "phone-refusal": {
      platform: "web", route,
      script: { environments: [{ name: "desk", reach: "paired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, accounts: [{ label: "personal" }], sessions: [{ title: "Receipts" }], receipts: { "runs.start": { rejected: "account_unavailable", message: refusal } } }] },
      readySelector: '[aria-label="Message"]',
    },
  });
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const input = screen.getByRole("textbox", { name: "Message" });
  fireEvent.change(input, { target: { value: "Explain the receipt totals.\n".repeat(6) } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  const line = await screen.findByText(`Not sent: ${refusal}`);
  expect(input).toHaveProperty("value", "Explain the receipt totals.\n".repeat(6));
  const column = line.closest("[data-composer-column]")!;
  expect(column.contains(screen.getByRole("button", { name: "Run settings" }))).toBe(true);
  // Exercise the hosted lookup against production markup, including text-named
  // Run settings and the icon-only Send beside an equally empty Attach files.
  const send = screen.getByRole("button", { name: "Send" });
  expect(send.textContent).toBe(screen.getByRole("button", { name: "Attach files" }).textContent);
  for (const control of [screen.getByRole("button", { name: "Run settings" }), send, line]) {
    expect(window.eval(composerControlExpression(control.textContent, control.getAttribute("aria-label")))).toBe(control);
  }
  const style = document.createElement("style"); style.textContent = readFileSync(new URL("./phone-conversation.css", import.meta.url), "utf8"); document.head.append(style);
  onTestFinished(() => style.remove());
  // jsdom has no layout: check the actual phone rule matching the rendered refusal's scroll owner.
  const rules = Array.from(style.sheet?.cssRules ?? []).filter((rule): rule is CSSStyleRule => rule.type === 1).filter(rule => column.matches(rule.selectorText));
  expect(rules.some(rule => ["auto", "scroll"].includes(rule.style.getPropertyValue("overflow-y")))).toBe(true);
});

it("lets a phone user scroll away from the focused input without the viewport pulling it back", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, width: 360, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerWidth", 360);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, "phone-gallery-conversation");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const field = screen.getByRole("textbox", { name: "Message" });
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const frame = root.querySelector<HTMLElement>("[data-web-client]")!;
  const column = field.closest<HTMLElement>("[data-composer-column]")!;
  onTestFinished(() => scroll.mockRestore());
  act(() => field.focus());
  expect(scroll).not.toHaveBeenCalled();
  column.scrollTop = 37;
  // Scrolling to a refusal/Send can move the visual viewport while focus remains in the field.
  viewport.offsetTop = 30;
  act(() => viewport.dispatchEvent(new Event("scroll")));
  expect(scroll).not.toHaveBeenCalled();
  expect(column.scrollTop).toBe(37);
  expect(frame.style.top).toBe("30px");
  viewport.height = 480;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(scroll).not.toHaveBeenCalled();
  expect(column.scrollTop).toBe(37);
  expect(frame.style.getPropertyValue("--phone-viewport-height")).toBe("480px");
});


it.each([["phone-bank-authoring", 390], ["settings-bank-authoring", 1024]] as const)("keeps workspace checks out of the parked %s decisions and restores them after answering", async (scene, width) => {
  vi.stubGlobal("innerWidth", width);
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation(query => query === "(width < 640px)"
    ? Object.assign(new EventTarget(), { matches: width < 640, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const root = document.createElement("div"); root.id = "root"; document.body.append(root);
  const gallery = await mountGallery(root, scene, "dark");
  onTestFinished(async () => { await gallery.close(); root.remove(); });
  await gallery.ready;
  const dialog = screen.getByRole("dialog", { name: "Authoring conversation" });
  const decisions = within(dialog).getByRole("group", { name: "Question decision" });
  expect(within(decisions).getByRole("button", { name: "Send answers" })).toBeDefined();
  expect(within(dialog).getByRole("textbox", { name: "Message" })).toBeDefined();
  expect(within(dialog).queryByRole("region", { name: "Workspace check" })).toBeNull();
  for (const option of within(dialog).getAllByRole("radio", { name: "Working agreements" })) fireEvent.click(option);
  fireEvent.click(within(decisions).getByRole("button", { name: "Send answers" }));
  await waitFor(() => expect(within(dialog).getAllByRole("region", { name: "Workspace check" })).toHaveLength(1));
});


it("renders the filled keyboard-proof permission card through the prompt contract", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Receipts" }] }] });
  app.open("desk");
  await screen.findByRole("textbox", { name: "Message" });
  const env = app.environment("desk");
  act(() => {
    env.startRun(env.sessionId(), "Read the receipts");
    env.openPrompt(env.sessionId(), filledKeyboardPrompt);
  });
  const card = await screen.findByRole("region", { name: "Parked prompt" });
  expect(within(card).getByRole("button", { name: "Allow once" })).toBeDefined();
});
