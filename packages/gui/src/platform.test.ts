import { createRuntime } from "@agent-harness/client-runtime";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { browserNetwork, browserPlatform, systemClock } from "./platform/browser-platform.js";

const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI = "Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const WINDOWS_EDGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0";

/**
 * The bundle's platform (docs/specs/gui.md, "The desktop platform"): what the
 * runtime needs from the window, from what every browser has.
 */
describe("the bundle's platform", () => {
  it("follows the browser's online and offline events", () => {
    const network = browserNetwork(window);
    const seen: boolean[] = [];
    network.subscribe((state) => seen.push(state.online));
    const online = vi.spyOn(window.navigator, "onLine", "get");

    online.mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(network.read()).toMatchObject({ online: false });
    online.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("online"));
    expect(seen).toEqual([false, true]);
    online.mockRestore();
  });

  it("is in the foreground while the page is visible", () => {
    const network = browserNetwork(window);
    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(network.read()).toMatchObject({ foreground: false });
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(network.read()).toMatchObject({ foreground: true });
    visibility.mockRestore();
  });

  it("runs a timer on the system clock, and cancels one", async () => {
    const clock = systemClock();
    const ran: string[] = [];
    clock.setTimeout(() => ran.push("due"), 0).cancel();
    await new Promise<void>((resolve) => clock.setTimeout(() => (ran.push("ran"), resolve()), 1));
    expect(ran).toEqual(["ran"]);
  });

  it("is a web client's, with its version, keeping documents as JSON in memory", async () => {
    const platform = browserPlatform(window, "0.5.0");
    expect(platform.client).toMatchObject({ kind: "web", version: "0.5.0" });
    await platform.documents.set("presentation", { format: 1 });
    expect(await platform.documents.get("presentation")).toEqual({ format: 1 });
    await expect(platform.documents.set("x", { cut: BigInt(1) })).rejects.toThrow();
  });

  it.each([
    [ANDROID_CHROME, "(display-mode: browser)", "Chrome on Android (tab)"],
    [ANDROID_CHROME, "(display-mode: standalone)", "Chrome on Android (Home Screen)"],
    [IPAD_SAFARI, "(display-mode: standalone)", "Safari on iPad (Home Screen)"],
    [WINDOWS_EDGE, "(display-mode: standalone)", "Edge on Windows (installed app)"],
    [WINDOWS_EDGE, "(display-mode: browser)", "Edge on Windows (tab)"],
    ["", "(display-mode: browser)", "A browser (tab)"],
  ])("pairs under a label a person tells apart: browser and system from the user agent, installed or a tab (%#)", (userAgent, display, label) => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.spyOn(window, "matchMedia").mockImplementation((query) => Object.assign(new EventTarget(), { matches: query === display, media: query, onchange: null, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => true }));
    onTestFinished(() => { vi.restoreAllMocks(); });
    expect(browserPlatform(window, "0.5.0").client).toEqual({ kind: "web", label, version: "0.5.0" });
  });

  it("knows Safari's Home Screen copy by navigator.standalone, which it says instead of the display mode", () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(IPHONE_SAFARI);
    Object.defineProperty(window.navigator, "standalone", { configurable: true, value: true });
    onTestFinished(() => { vi.restoreAllMocks(); Reflect.deleteProperty(window.navigator, "standalone"); });
    expect(browserPlatform(window, "0.5.0").client.label).toBe("Safari on iPhone (Home Screen)");
  });

  it("has no shell, so this computer's gh is absent with its reason in a browser tab", () => {
    const platform = browserPlatform(window, "0.5.0");
    expect(platform.shell).toBeUndefined();
    const runtime = createRuntime(platform);
    onTestFinished(() => runtime.close());
    expect(runtime.capability("any", "shell.gh")).toEqual({
      status: "absent",
      reason: "no-shell",
      message: "This client cannot read the gh signed in on this computer: its shell has no shell.gh.",
    });
  });
});
