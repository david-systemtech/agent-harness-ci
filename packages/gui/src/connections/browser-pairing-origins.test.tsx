// @vitest-environment-options {"url":"https://environment.example"}
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
    const field = within(form).getByRole("textbox", { name: "Pairing link" });
    await user.clear(field);
    await user.click(field);
    await user.paste(link);
    await user.click(within(form).getByRole("button", { name: "Pair" }));
    const status = form.parentElement!.querySelector<HTMLElement>('[role="status"]')!;
    await waitFor(() => expect(status.textContent).toMatch(/^Not paired|^Use the environment|is paired already/));
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
  it("recognises same-origin pairing with or without the explicit HTTPS default port", async () => {
    const { pair, pairIn, runtime } = await servedByDesk(size);
    expect(runtime.connections.list.read()[0]?.address).toBe("https://environment.example");
    const status = await pair("https://environment.example/pair#K7Q2MXH4RT");
    expect(status.textContent).toContain("desk is paired already. Pair it again in place?");
    const again = await pairIn(await screen.findByRole("dialog", { name: "Settings" }), "https://environment.example:443/pair#K7Q2MXH4RT");
    expect(again.textContent).toContain("desk is paired already. Pair it again in place?");
  });

  it("refuses a standard-port HTTPS origin without adding the native HTTP port or fetching it", async () => {
    const { pair, fetched } = await servedByDesk(size);
    const status = await pair("https://unapproved.example.invalid/pair#K7Q2MXH4RT");
    expect(status.textContent).toContain("This browser client may not contact https://unapproved.example.invalid.");
    expect(status.textContent).not.toContain(":7433");
    expect(fetched.filter((url) => url.startsWith("https://unapproved.example.invalid"))).toEqual([]);
  });

  it("contacts an exactly approved standard-port HTTPS origin, including links naming port 443, but refuses another port", async () => {
    const approved = "https://laptop.example.test";
    const { pair, pairIn, fetched } = await servedByDesk(size, [approved]);
    const status = await pair(`${approved}/pair#K7Q2MXH4RT`);
    expect(status.textContent).toBe(`Not paired: Nothing answered at ${approved}: fetch failed.`);
    expect(fetched).toContain(`${approved}/.well-known/agent-harness/environment`);
    const settings = await screen.findByRole("dialog", { name: "Settings" });
    const defaultPort = await pairIn(settings, `${approved}:443/pair#K7Q2MXH4RT`);
    expect(defaultPort.textContent).toBe(`Not paired: Nothing answered at ${approved}: fetch failed.`);
    expect(fetched.filter((url) => url.startsWith(approved))).toEqual([
      `${approved}/.well-known/agent-harness/environment`,
      `${approved}/.well-known/agent-harness/environment`,
    ]);
    const otherPort = await pairIn(settings, `${approved}:8443/pair#K7Q2MXH4RT`);
    expect(otherPort.textContent).toContain(`This browser client may not contact ${approved}:8443`);
    expect(fetched.filter((url) => url.startsWith(`${approved}:8443`))).toEqual([]);
  });

  it("refuses an origin this environment does not allow before any fetch, names it, says both steps and goes to Browser origins", async () => {
    const { user, pair, goneToOrigins, fetched, scrolled } = await servedByDesk(size);
    const status = await pair(LINK);
    expect(status.textContent).toContain(`This browser client may not contact ${OTHER}`);
    expect(status.textContent).toContain(`add ${OTHER} to desk's Allowed connection origins under Your machines, Browser origins, then reload this page`);
    expect(status.textContent).toContain(`ask that environment's admin to add this client's origin, ${location.origin}, to its Allowed client origins`);
    expect(status.textContent).not.toContain("Nothing answered");
    expect(fetched.filter((url) => url.startsWith(OTHER))).toEqual([]);
    expect(scrolled).toContain(status);
    // Each origin is its own code run, which wraps whole rather than at its hyphens on a phone (#1739).
    expect(Array.from(status.querySelectorAll("code[data-pairing-origin]"), (origin) => origin.textContent)).toEqual([OTHER, OTHER, location.origin]);
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
