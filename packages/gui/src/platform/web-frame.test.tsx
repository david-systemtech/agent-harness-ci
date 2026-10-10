import { act, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { PROTOCOL_VERSION } from "@agent-harness/contracts";
import { App } from "../app.js";
import { WebViewport } from "./web-frame.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform, type BrowserPlatform } from "./browser-platform.js";

beforeEach(() => {
  const original = window.matchMedia;
  vi.stubGlobal("matchMedia", (query: string) => query === "(width < 640px)"
    ? Object.defineProperty(Object.assign(new EventTarget(), { media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined }), "matches", { get: () => window.innerWidth < 640 }) : original(query));
  onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
});

it("pairs without a desktop shell, discloses the minted grant and opens a shared conversation", async () => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" }, sessions: [{ title: "Check the receipts" }] }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  // HTTPS is the browser-facing transport; the scripted peer has no TLS listener.
  const platform: BrowserPlatform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url, request) => world.fetch(url.replace(/^https:/, "http:"), request),
    webSocket: (url, handlers) => world.webSocket(url.replace(/^wss:/, "ws:"), handlers),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const env = world.environment("desk");
  const link = env.wire.link.replace(/^http:/, "https:");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  await screen.findByRole("note", { name: "Limited access" });
  expect(screen.queryByText(/Starting this machine/)).toBeNull();
  const user = userEvent.setup();
  await screen.findByRole("option", { name: "Check the receipts" });
  await user.selectOptions(screen.getByRole("combobox", { name: "Sessions" }), `${env.environmentId}/${env.sessionId()}`);
  await screen.findByRole("textbox", { name: "Message" });
  expect(location.hash).toContain(`/session/${env.environmentId}/${env.sessionId()}`);
  const runId = await act(async () => {
    const { runId } = env.startRun(env.sessionId(), "Check the receipts");
    env.emit(env.sessionId(), "assistant.delta", { runId, itemId: "reply", fragments: [{ kind: "text", text: "The receipt totals agree. " }] });
    return runId;
  });
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("The receipt totals agree."));
  await act(async () => {
    env.emit(env.sessionId(), "assistant.text", { runId, itemId: "reply", text: "The receipt totals agree.", aborted: false });
    env.endRun(env.sessionId(), runId);
    const next = env.startRun(env.sessionId(), "Check the next receipt");
    env.emit(env.sessionId(), "assistant.delta", { runId: next.runId, itemId: "next-reply", fragments: [{ kind: "text", text: "The next receipt agrees. " }] });
  });
  await waitFor(() => expect(screen.getAllByRole("article", { name: "Reply" }).at(-1)?.textContent).toBe("The next receipt agrees."));
  await waitFor(() => expect(platform.shell).toBeUndefined());
  const incoming = new URL(link);
  app.rerender(<App key="new-pairing-visit" runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { address: incoming.origin, code: incoming.hash.slice(1) } } }} />);
  await screen.findByDisplayValue(link);
  expect(screen.getByRole("note", { name: "Limited access" })).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Pair" }));
  await user.click(await screen.findByRole("button", { name: "Connect again" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Pair with this environment" })).toBeNull());


  history.replaceState(null, "", "/");
});

it("says a handed link's refusal as the pairing alert, the raw failure in its Details, never in the line", async () => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", discovery: "nothing" }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform: BrowserPlatform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url, request) => world.fetch(url.replace(/^https:/, "http:"), request),
    webSocket: (url, handlers) => world.webSocket(url.replace(/^wss:/, "ws:"), handlers),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const link = world.environment("desk").wire.link.replace(/^http:/, "https:");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  const host = new URL(link).host;
  const line = await screen.findByText(`Nothing answered at ${host}. Check that the other computer is on and that both are connected to Tailscale.`);
  const alert = line.closest("[data-pairing-refusal]");
  expect(alert?.getAttribute("role")).toBe("alert");
  expect(alert?.textContent).not.toContain("http");
  await userEvent.setup().click(within(alert as HTMLElement).getByRole("button", { name: "Details" }));
  expect(within(alert as HTMLElement).getByText(/Nothing answered at https?:\/\//, { selector: "pre" })).toBeDefined();
  history.replaceState(null, "", "/");
});

it("says a handed link's thrown pairing failure as §4.2's Pairing did not work, the thrown message in its Details", async () => {
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired" }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform: BrowserPlatform = { ...browserPlatform(view, "0.0.0"), clock, fetch: world.fetch, webSocket: world.webSocket };
  const runtime = createRuntime(platform);
  await runtime.start();
  vi.spyOn(runtime.connections, "add").mockRejectedValue(new Error("The store for tests could not be written."));
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { link: world.environment("desk").wire.link } } }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  const alert = (await screen.findByText("Pairing did not work. Try again.")).closest("[data-pairing-refusal]");
  expect(alert?.getAttribute("role")).toBe("alert");
  expect(screen.queryByText("Pairing…")).toBeNull();
  await userEvent.setup().click(within(alert as HTMLElement).getByRole("button", { name: "Details" }));
  expect(within(alert as HTMLElement).getByText(/The store for tests could not be written\./, { selector: "pre" })).toBeDefined();
  history.replaceState(null, "", "/");
});

it("bounds browser surfaces when only the visual viewport shrinks for the keyboard", () => {
  vi.stubGlobal("innerWidth", 390);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const inner = Object.getOwnPropertyDescriptor(window, "innerHeight");
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
  onTestFinished(() => {
    if (previous) Object.defineProperty(window, "visualViewport", previous);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    if (inner) Object.defineProperty(window, "innerHeight", inner);
  });
  const app = render(<WebViewport><p>Terminal slot</p></WebViewport>);
  const frame = app.container.firstElementChild as HTMLElement;
  expect(getComputedStyle(frame).height).toBe("844px");
  act(() => { viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  expect(window.innerHeight).toBe(844);
  expect(getComputedStyle(frame).height).toBe("480px");
  act(() => { viewport.height = 844; viewport.dispatchEvent(new Event("resize")); });
  expect(getComputedStyle(frame).height).toBe("844px");
  act(() => { viewport.scale = 2; viewport.height = 422; viewport.dispatchEvent(new Event("resize")); });
  expect(getComputedStyle(frame).height).toBe("844px");
  expect(app.container.firstElementChild).toBe(frame);
});


it("preserves an embedded browser frame's height rule while bounding the visual viewport", () => {
  const previous = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const viewport = Object.assign(new EventTarget(), { height: 900 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const style = document.createElement("style");
  style.textContent = "[data-web-gallery] [data-web-client] { height: 100%; }";
  document.head.append(style);
  onTestFinished(() => {
    style.remove();
    if (previous) Object.defineProperty(window, "visualViewport", previous);
    else delete (window as { visualViewport?: unknown }).visualViewport;
  });
  const app = render(<div data-web-gallery style={{ height: 844 }}><WebViewport><p>Conversation slot</p></WebViewport></div>);
  const frame = app.container.querySelector<HTMLElement>("[data-web-client]")!;
  expect(getComputedStyle(frame).height).toBe("100%");
  expect(getComputedStyle(frame).maxHeight).toBe("900px");
});


it.each([[false, 844], [true, 844], [false, 780], [true, 780]] as const)("owns phone bounds, preserves zoom and restores the document with layout resize %s and unoccluded height %s", (resizeLayout, unoccludedHeight) => {
  const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal("innerHeight", 844);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
  const app = render(<WebViewport narrow><textarea aria-label="Message" defaultValue="Keep this draft" /><button>Send</button></WebViewport>);
  const frame = app.container.firstElementChild as HTMLElement;
  act(() => { window.innerHeight = unoccludedHeight; viewport.height = unoccludedHeight; viewport.dispatchEvent(new Event("resize")); });
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  act(() => { if (resizeLayout) window.innerHeight = 480; viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
  act(() => { viewport.offsetTop = 120; viewport.dispatchEvent(new Event("scroll")); screen.getByRole("textbox", { name: "Message" }).focus(); });
  expect(frame.style.height).toBe("480px");
  expect(frame.style.top).toBe("120px");
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  act(() => screen.getByRole("button", { name: "Send" }).focus());
  expect(frame.hasAttribute("data-phone-composing")).toBe(true);
  act(() => screen.getByRole("textbox", { name: "Message" }).focus());
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(true);
  expect(scroll).not.toHaveBeenCalled();
  viewport.scale = 2; viewport.height = 240;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.height).toBe("480px");
  viewport.scale = 1; viewport.height = unoccludedHeight; viewport.offsetTop = 0; window.innerHeight = unoccludedHeight;
  act(() => viewport.dispatchEvent(new Event("resize")));
  expect(frame.style.height).toBe(`${unoccludedHeight}px`);
  expect(frame.hasAttribute("data-phone-composing")).toBe(false);
  expect(frame.style.top).toBe("0px");
  expect(screen.getByRole("textbox", { name: "Message" })).toHaveProperty("value", "Keep this draft");
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message" }));
  act(() => { window.innerWidth = 1000; window.dispatchEvent(new Event("resize")); });
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(false);
  expect(frame.style.top).toBe("");
  app.unmount();
  expect(frame.style.height).toBe("");
});

it("bounds a phone without VisualViewport and removes listeners on unmount", () => {
  vi.stubGlobal("visualViewport", undefined); vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 740);
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const app = render(<WebViewport narrow><p>Conversation</p></WebViewport>);
  const frame = app.container.firstElementChild as HTMLElement;
  expect(frame.style.height).toBe("740px");
  act(() => { window.innerHeight = 480; window.dispatchEvent(new Event("resize")); });
  expect(frame.style.height).toBe("480px");
  app.unmount();
  act(() => window.dispatchEvent(new Event("resize")));
  expect(frame.style.height).toBe("");
  expect(document.documentElement.hasAttribute("data-phone-viewport")).toBe(false);
});

/** A phone-sized web client paired with `desk`, open on its conversation. */
const pairedPhone = async () => {
  vi.stubGlobal("innerWidth", 390); vi.stubGlobal("innerHeight", 844);
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read", "sessions:write", "runs:drive"], hello: { ceiling: "acceptEdits" } }] });
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform: BrowserPlatform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url, request) => world.fetch(url.replace(/^https:/, "http:"), request),
    webSocket: (url, handlers) => world.webSocket(url.replace(/^wss:/, "ws:"), handlers),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("runLocalEnvironment", false); presentation.set("firstLaunchDone", true);
  const env = world.environment("desk");
  const link = env.wire.link.replace(/^http:/, "https:");
  expect(await runtime.connections.add({ link })).toMatchObject({ status: "paired" });
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: {} }} />);
  onTestFinished(async () => { app.unmount(); await runtime.close(); await presentation.close(); });
  await screen.findByRole("note", { name: "Limited access" });
  return { runtime, env, link };
};
const blockedLine = () => waitFor(() => { const found = document.querySelector<HTMLElement>("[data-connection-blocked]"); expect(found).not.toBeNull(); return found!; });

it("offers a revoked phone Pair again on its blocked line, outside every menu, and pairs that connection again in place", async () => {
  const { runtime, env, link } = await pairedPhone();
  act(() => env.wire.server.bye("revoked"));
  const line = await blockedLine();
  expect(line.textContent).toContain("This app's access to desk was taken away. Pair again.");
  expect(line.textContent).not.toContain("choose Pair.");
  const again = within(line).getByRole("button", { name: "Pair again" });
  expect(screen.queryByRole("menu")).toBeNull();
  const user = userEvent.setup();
  await user.click(again);
  expect(screen.getByRole("heading", { name: "Pair with this environment" })).toBeDefined();
  await user.type(screen.getByRole("textbox", { name: "Pairing link" }), link);
  await user.click(screen.getByRole("button", { name: "Pair" }));
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Pair with this environment" })).toBeNull());
  expect(document.querySelector("[data-connection-blocked]")).toBeNull();
  expect(screen.queryByText(/Already paired/)).toBeNull();
  expect(runtime.connections.list.read().filter(record => record.environmentId === env.environmentId)).toHaveLength(1);
});

it("says a phone blocked by a newer environment needs this client updated, with no Pair again", async () => {
  const { env } = await pairedPhone();
  act(() => env.wire.server.bye("protocol", { protocolVersion: PROTOCOL_VERSION + 1 }));
  const line = await blockedLine();
  expect(line.textContent).toBe("desk runs a newer agent-harness than this app. Update this app.");
  expect(within(line).queryByRole("button")).toBeNull();
});
