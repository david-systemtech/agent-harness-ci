import { render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRuntime } from "@agent-harness/client-runtime";
import { manualClock } from "@agent-harness/client-runtime/testing";
import { scriptedWorld } from "@agent-harness/client-runtime/testing/scripted-environment";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { App } from "../app.js";
import { openPresentation } from "../presentation.js";
import { browserPlatform } from "../platform/browser-platform.js";

/**
 * Pairing another HTTPS environment from a browser tab (#1713). The page's
 * Content-Security-Policy lets it contact its own origin and the serving
 * environment's Allowed connection origins only, so a link for any other
 * origin is refused before any fetch, in words that say how to allow it;
 * an allowed origin where nothing answers still says Nothing answered; and
 * the line that says so is scrolled into view on a phone. The sizes name
 * the phones the ticket measured; jsdom lays nothing out, so the scroll is
 * read from `scrollIntoView`.
 */

const OTHER = "https://laptop.example.test:8444";
const LINK = `${OTHER}/pair#K7Q2MXH4RT`;

/** The phone web client at `width` x `height`, served by desk (paired at the page's origin), Settings set to open on Your machines. */
const servedByDesk = async (size: { readonly width: number; readonly height: number }, connectOrigins: readonly string[] = []) => {
  vi.stubGlobal("innerWidth", size.width); vi.stubGlobal("innerHeight", size.height);
  const matchMedia = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.assign(matchMedia(query), { matches: query === "(width < 640px)" }));
  const scrolled: Element[] = [];
  const scrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  const clock = manualClock();
  const world = scriptedWorld(clock, { environments: [{ name: "desk", reach: "unpaired", scopes: ["read"], webOrigins: { connectOrigins } }] });
  const origin = new URL(world.environment("desk").wire.link).origin;
  const fetched: string[] = [];
  const view = Object.assign(Object.create(window) as Window & typeof globalThis, { indexedDB: new IDBFactory() });
  const platform = { ...browserPlatform(view, "0.0.0"), clock,
    fetch: (url: string, init?: Parameters<typeof world.fetch>[1]) => { fetched.push(url); return world.fetch(url.replace(location.origin, origin), init); },
    webSocket: (...args: Parameters<typeof world.webSocket>) => world.webSocket(args[0].replace(location.origin.replace(/^http/, "ws"), origin.replace(/^http/, "ws")), args[1]),
  };
  const runtime = createRuntime(platform);
  await runtime.start();
  const presentation = await openPresentation(platform.documents);
  presentation.set("firstLaunchDone", true); presentation.set("runLocalEnvironment", false); presentation.set("settingsRow", "environments.machines");
  const app = render(<App runtime={runtime} presentation={presentation} clock={clock} version="0.0.0" macOS={false} web={{ platform, route: { pairing: { address: location.origin, code: new URL(world.environment("desk").wire.link).hash.slice(1) } } }} />);
  onTestFinished(async () => {
    app.unmount(); await runtime.close(); await presentation.close(); vi.unstubAllGlobals(); vi.restoreAllMocks();
    if (scrollIntoView) Object.defineProperty(Element.prototype, "scrollIntoView", scrollIntoView);
    else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  await screen.findByRole("note", { name: "Limited access" });
  const user = userEvent.setup();
  /** Pastes `link` into the pairing form in `place` and sends it; the line under the form once it says more than Pairing…. */
  const pairIn = async (place: HTMLElement, link: string) => {
    const form = await within(place).findByRole("form", { name: "Pair by link" });
    await user.click(within(form).getByRole("textbox", { name: "Pairing link" }));
    await user.paste(link);
    await user.click(within(form).getByRole("button", { name: "Pair" }));
    const status = form.parentElement!.querySelector<HTMLElement>('[role="status"]')!;
    await waitFor(() => expect(status.textContent).toMatch(/^Not paired|^Use the environment/));
    return status;
  };
  /** Settings, opened from the phone header. */
  const openSettings = async () => {
    await user.click(screen.getByRole("button", { name: "Settings" }));
    return screen.findByRole("dialog", { name: "Settings" });
  };
  /** Pastes `link` into Settings' Add a machine form and sends it. */
  const pair = async (link: string) => pairIn(await openSettings(), link);
  /** desk's Browser origins, once they have the focus. */
  const goneToOrigins = async () => {
    const card = within(await screen.findByRole("dialog", { name: "Settings" })).getByRole("region", { name: "desk" });
    const origins = within(card).getByRole("region", { name: "Browser origins" });
    await waitFor(() => expect(document.activeElement).toBe(origins));
    expect(scrolled).toContain(origins);
    return origins;
  };
  return { user, pair, pairIn, openSettings, goneToOrigins, fetched, scrolled, runtime, world };
};

const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 640 }] as const;

describe.each(PHONES)("pairing another HTTPS environment from the browser client at $width x $height", (size) => {
  it("refuses an origin this environment does not allow before any fetch, names it, says both steps and goes to Browser origins", async () => {
    const { user, pair, goneToOrigins, fetched, scrolled } = await servedByDesk(size);
    const status = await pair(LINK);
    expect(status.textContent).toContain(`This browser client may not contact ${OTHER}`);
    expect(status.textContent).toContain(`add ${OTHER} to desk's Allowed connection origins under Your machines, Browser origins, then reload this page`);
    expect(status.textContent).toContain(`ask that environment's admin to add this client's origin, ${location.origin}, to its Allowed client origins`);
    expect(status.textContent).not.toContain("Nothing answered");
    expect(fetched.filter((url) => url.startsWith(OTHER))).toEqual([]);
    expect(scrolled).toContain(status);
    await user.click(within(status).getByRole("button", { name: "Browser origins" }));
    await goneToOrigins();
  });

  it("offers the same words and the way to Browser origins on the phone's own pairing screen", async () => {
    const { user, pairIn, goneToOrigins, fetched } = await servedByDesk(size);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Pair with an environment" }));
    const screenOf = (await screen.findByRole("heading", { name: "Pair with this environment" })).parentElement!;
    const status = await pairIn(screenOf, LINK);
    expect(status.textContent).toContain(`This browser client may not contact ${OTHER}`);
    expect(fetched.filter((url) => url.startsWith(OTHER))).toEqual([]);
    await user.click(within(status).getByRole("button", { name: "Browser origins" }));
    await goneToOrigins();
  });

  it("keeps Nothing answered for an allowed origin where nothing answers", async () => {
    const { pair, fetched, scrolled } = await servedByDesk(size, [OTHER]);
    const status = await pair(LINK);
    expect(status.textContent).toBe(`Not paired: Nothing answered at ${OTHER}: fetch failed.`);
    expect(fetched.some((url) => url.startsWith(OTHER))).toBe(true);
    expect(scrolled).toContain(status);
  });

  it("refuses an HTTP link before any fetch, and scrolls the line into view", async () => {
    const { pair, fetched, scrolled } = await servedByDesk(size);
    const status = await pair("http://laptop.example.test:8444/pair#K7Q2MXH4RT");
    expect(status.textContent).toBe("Use the environment’s HTTPS pairing link or HTTPS address. HTTP connections are unavailable in the browser.");
    expect(fetched.filter((url) => url.startsWith("http://laptop.example.test"))).toEqual([]);
    expect(scrolled).toContain(status);
  });
});
