import { describe, expect, it } from "vitest";
import { CdpFailure, SCRIPTED_SCREENSHOT, type ScriptedTarget } from "../testing/index.js";
import { cdpPageDriver } from "./driver.js";
import type { FrameArrival } from "./page.js";
import { PAGE, driven, enabledDomains, listed, manualClock, plainPolicy, type Driven } from "../../test/driven.js";

/**
 * The CDP page driver over the scripted CDP peer on a real wire (browser
 * spec, "One page driver for three browsers"): what the peer is sent, and
 * what each verb answers, value or sentence.
 */

/** The in-page answers a page with one field gives: the element found at (320, 240), a field that takes text. */
const withField = (peer: Driven["peer"], editable = true): void => {
  peer.inPage("locateElement", () => ({ kind: "found", x: 320, y: 240, editable }));
  peer.inPage("selectFieldContents", () => "selected");
};

const mouse = (peer: Driven["peer"]) => peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => params);

describe.each(["web-socket", "pipe"] as const)("the page driver over %s", (wire) => {
  it("enables only Page at attach: open, navigate, screenshot, click and type send no Runtime.enable, Log.enable or Network.enable", async () => {
    const { peer, perform } = await driven({ wire });
    withField(peer);
    expect(await perform("open", { url: "https://example.com/" })).toMatchObject({ ok: true, value: { url: "https://example.com/" } });
    expect(await perform("navigate", { url: "https://example.com/next" })).toMatchObject({ ok: true, value: { url: "https://example.com/next" } });
    expect(await perform("screenshot", {})).toMatchObject({ ok: true });
    expect(await perform("click", { target: { selector: "#go" } })).toMatchObject({ ok: true });
    expect(await perform("type", { target: { selector: "#name" }, text: "Ada" })).toMatchObject({ ok: true });
    expect(enabledDomains(peer)).toEqual(["Page.enable"]);
  });
});

describe("lazy domains", () => {
  it.each(["console", "network", "cookies", "storage", "evaluate"] as const)("turn on Runtime, Log and Network with the first %s verb, and only once", async (verb) => {
    const { peer, perform } = await driven({ kind: "headless" });
    await perform("open", { url: "https://example.com/" });
    const args = verb === "evaluate" ? { expression: "1 + 1" } : {};
    expect(await perform(verb, args as never)).toMatchObject({ ok: true });
    expect(await perform(verb, args as never)).toMatchObject({ ok: true });
    expect(enabledDomains(peer)).toEqual(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]);
  });

  it("turns them on for every cross-site frame's child target too, and for one that arrives after", async () => {
    const { peer, perform } = await driven({ kind: "headless" });
    peer.document("https://shop.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    await perform("open", { url: "https://shop.example/" });
    await perform("console", {});
    const child = peer.target(peer.sentOf("Page.getFrameTree").at(-1)?.targetId as string);
    expect(child.type).toBe("iframe");
    const onChild = (method: string) => peer.sentOf(method).filter((command) => command.targetId === child.targetId).length;
    expect(["Runtime.enable", "Log.enable", "Network.enable"].map(onChild)).toEqual([1, 1, 1]);

    const later = peer.target(peer.sentOf("Page.navigate")[0]?.targetId as string).addCrossSiteFrame("https://ads.example/slot");
    const onLater = (method: string) => peer.sentOf(method).filter((command) => command.targetId === later.targetId).length;
    await expect.poll(() => onLater("Runtime.runIfWaitingForDebugger"), { timeout: 30_000 }).toBe(1);
    expect(["Runtime.enable", "Log.enable", "Network.enable"].map(onLater)).toEqual([1, 1, 1]);
  });

  it("gives every cross-site frame's child target Network once, when the host asked for it at attach and a deep verb came after", async () => {
    const { peer, perform } = await driven({ kind: "headless", networkAtAttach: true });
    peer.document("https://shop.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    await perform("open", { url: "https://shop.example/" });
    await perform("console", {});
    const page = peer.target(peer.sentOf("Page.navigate")[0]?.targetId as string);
    const later = page.addCrossSiteFrame("https://ads.example/slot");
    const on = (targetId: string, method: string) => peer.sentOf(method).filter((command) => command.targetId === targetId).length;
    await expect.poll(() => on(later.targetId, "Runtime.runIfWaitingForDebugger"), { timeout: 30_000 }).toBe(1);
    for (const target of [page.targetId, page.children[0]?.targetId as string, later.targetId]) expect(on(target, "Network.enable"), target).toBe(1);
  });

  it("turns them on before the load on a dev site, where debugging is the point: a listed host, or this machine's own address", async () => {
    const { peer, perform } = await driven({ policy: { ...plainPolicy, devSites: ["*.myapp.test"] } });
    await perform("open", { url: "https://staging.myapp.test/" });
    const methods = peer.sent.map((command) => command.method);
    expect(methods.indexOf("Runtime.enable")).toBeGreaterThan(-1);
    expect(methods.indexOf("Network.enable")).toBeLessThan(methods.indexOf("Page.navigate"));

    const local = await driven();
    await local.perform("open", { url: "localhost:5173" });
    expect(enabledDomains(local.peer)).toEqual(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]);
    expect(local.peer.sentOf("Page.navigate")[0]?.params).toEqual({ url: "http://localhost:5173" });
  });

  it("turns them on at attach when the page is already on a dev site", async () => {
    const { peer, host, driver } = await driven();
    const tab = peer.createPage("http://127.0.0.1:3000/");
    host.targets.set(PAGE, tab.targetId);
    await driver.perform({ pageKey: PAGE, command: { verb: "screenshot", args: {} } });
    expect(enabledDomains(peer)).toEqual(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"]);
  });

  it("enables Network alone at attach when the host asks for it, as the headless browser does", async () => {
    const { peer, perform } = await driven({ kind: "headless", networkAtAttach: true });
    await perform("open", { url: "https://example.com/" });
    expect(enabledDomains(peer)).toEqual(["Page.enable", "Network.enable"]);
    await perform("console", {});
    expect(enabledDomains(peer)).toEqual(["Page.enable", "Network.enable", "Runtime.enable", "Log.enable"]);
  });
});

describe("isolated worlds", () => {
  it("runs every in-page function in a world the driver made for its frame, never in the page's main world", async () => {
    const { peer, perform } = await driven();
    withField(peer);
    await perform("open", { url: "https://example.com/" });
    await perform("click", { target: { selector: "#go" } });
    await perform("navigate", { url: "https://example.com/next" });
    await perform("type", { target: { selector: "#name" }, text: "Ada" });

    const worlds = peer.sentOf("Page.createIsolatedWorld");
    expect(worlds.map(({ params }) => params.worldName)).toEqual(["agent-harness", "agent-harness"]);
    const calls = peer.sentOf("Runtime.callFunctionOn");
    expect(calls).toHaveLength(3);
    // The world is made again for the new document: the first one went with the page it was made in.
    expect(calls.map(({ params }) => params.executionContextId)).toEqual([1, 2, 2]);
    expect(calls.every(({ params }) => params.returnByValue === true && typeof params.functionDeclaration === "string")).toBe(true);
    expect(peer.sentOf("Runtime.evaluate")).toEqual([]);
  });

  it("makes the world again, once, when its document went between the driver's two calls", async () => {
    const { peer, perform } = await driven();
    withField(peer, false);
    await perform("open", { url: "https://example.com/" });
    let calls = 0;
    // The first call finds its world gone, as a call racing a reload does.
    peer.answer("Runtime.callFunctionOn", (call) => {
      if (++calls === 1) throw new CdpFailure("Cannot find context with specified id");
      return call.fallback();
    });
    expect(await perform("click", { target: { selector: "#go" } })).toMatchObject({ ok: true });
    expect(peer.sentOf("Page.createIsolatedWorld")).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("answers a sentence when the world is gone a second time, never throwing", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.answer("Runtime.callFunctionOn", () => {
      throw new CdpFailure("Cannot find context with specified id");
    });
    expect(await perform("click", { target: { selector: "#go" } })).toEqual({
      ok: false,
      reason: "The browser failed: Runtime.callFunctionOn: Cannot find context with specified id.",
    });
    expect(peer.sentOf("Page.createIsolatedWorld")).toHaveLength(2);
  });
});

describe("open, navigate and screenshot", () => {
  it("sets a 1280 by 800 viewport at attach and answers a screenshot as a JPEG at quality 70 of it", async () => {
    const { peer, perform } = await driven();
    await perform("open", {});
    expect(peer.sentOf("Emulation.setDeviceMetricsOverride")[0]?.params).toEqual({ width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    expect(await perform("screenshot", {})).toEqual({ ok: true, value: { mimeType: "image/jpeg", data: SCRIPTED_SCREENSHOT } });
    expect(peer.sentOf("Page.captureScreenshot")[0]?.params).toEqual({ format: "jpeg", quality: 70 });
  });

  it("opens the session's page when it has none, and answers where it is when no address is given", async () => {
    const { peer, perform } = await driven();
    expect(await perform("open", {})).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
    expect(await perform("open", {})).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
    expect(peer.sentOf("Target.createTarget")).toHaveLength(1);
  });

  it("settles a load and answers the address it reached and its title, a redirect followed", async () => {
    const { peer, perform } = await driven();
    peer.document("https://example.com/old", { redirect: "https://www.example.com/new" });
    peer.document("https://www.example.com/new", { title: "The new page" });
    expect(await perform("open", { url: "https://example.com/old" })).toEqual({ ok: true, value: { url: "https://www.example.com/new", title: "The new page" } });
  });

  it("opens a bare host over https", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "example.com/docs" });
    expect(peer.sentOf("Page.navigate")[0]?.params).toEqual({ url: "https://example.com/docs" });
  });

  it("answers a load that never finishes with the page as it was once the bound passed, and says so", async () => {
    const clock = manualClock();
    const { peer, perform } = await driven({ clock });
    peer.holdLoads(true);
    const answer = perform("open", { url: "https://slow.example/" });
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBeGreaterThan(0);
    clock.advance(15_000);
    expect(await answer).toEqual({
      ok: true,
      value: { url: "https://slow.example/", title: "" },
      notice: "The page had not finished loading after 15 seconds; this is how it was then.",
    });
  });

  /** Starts a navigation of the page's own as the open verb reads where the page is, so the driver has heard it before the next verb. */
  const navigatesAfterOpening = (peer: Driven["peer"], url: string, then?: (target: ScriptedTarget) => void): void => {
    let pending = true;
    peer.answer("Page.getNavigationHistory", (call) => {
      if (pending && call.target) {
        pending = false;
        peer.holdLoads(true);
        call.target.navigate(url);
        then?.(call.target);
      }
      return call.fallback();
    });
  };

  it("lets a navigation already under way commit and parse before the next verb reads the page", async () => {
    const clock = manualClock();
    const { peer, perform, page } = await driven({ clock });
    navigatesAfterOpening(peer, "https://example.com/next");
    await perform("open", { url: "https://example.com/" });
    const shot = perform("screenshot", {});
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    expect(peer.sentOf("Page.captureScreenshot")).toEqual([]);
    page().finishLoading();
    expect(await shot).toMatchObject({ ok: true });
  });

  it("reads a parsed document at once though it never stops loading, a request that never ends delaying no verb", async () => {
    const clock = manualClock();
    const { peer, perform } = await driven({ clock });
    navigatesAfterOpening(peer, "https://example.com/stream", (target) => {
      const sessionId = peer.sentOf("Page.enable")[0]?.sessionId;
      const main = target.frames[0] as { id: string; loaderId: string };
      peer.emit("Page.lifecycleEvent", { frameId: main.id, loaderId: main.loaderId, name: "DOMContentLoaded", timestamp: 1 }, sessionId);
    });
    await perform("open", { url: "https://example.com/" });
    void perform("screenshot", {});
    await expect.poll(() => peer.sentOf("Page.captureScreenshot").length, { timeout: 30_000 }).toBe(1);
  });

  it("answers a load the browser could not make as a sentence with its error", async () => {
    const { peer, perform } = await driven();
    peer.answer("Page.navigate", (call) => (call.params.url === "about:blank" ? call.fallback() : { frameId: "x", loaderId: "y", errorText: "net::ERR_NAME_NOT_RESOLVED" }));
    expect(await perform("open", { url: "https://no-such-host.example/" })).toEqual({ ok: false, reason: "The browser could not load the page: net::ERR_NAME_NOT_RESOLVED." });
  });

  it("refuses an address that is no http or https page", async () => {
    const { peer, perform } = await driven();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "chrome://settings"]) {
      expect(await perform("open", { url })).toEqual({ ok: false, reason: `The browser opens http and https addresses only, and ${url} is neither.` });
    }
    expect(peer.sentOf("Page.navigate")).toEqual([]);
  });
});

describe("click and type by selector", () => {
  it("clicks by selector with real input at the element's centre, which the in-page function scrolled into view", async () => {
    const { peer, perform } = await driven();
    withField(peer, false);
    await perform("open", { url: "https://example.com/" });
    expect(await perform("click", { target: { selector: "button.buy" } })).toEqual({ ok: true, value: { url: "https://example.com/", title: "" } });
    expect(peer.sentOf("Runtime.callFunctionOn")[0]?.params.arguments).toEqual([{ value: { selector: "button.buy" } }]);
    expect(String(peer.sentOf("Runtime.callFunctionOn")[0]?.params.functionDeclaration)).toMatch(/^function locateElement\(/);
    expect(mouse(peer)).toEqual([
      { type: "mouseMoved", x: 320, y: 240 },
      { type: "mousePressed", x: 320, y: 240, button: "left", buttons: 1, clickCount: 1 },
      { type: "mouseReleased", x: 320, y: 240, button: "left", buttons: 0, clickCount: 1 },
    ]);
  });

  it("settles a navigation the click started and answers where it went", async () => {
    const { peer, perform } = await driven();
    withField(peer, false);
    peer.document("https://example.com/cart", { title: "Your cart" });
    peer.answer("Input.dispatchMouseEvent", (call) => {
      if (call.params.type === "mouseReleased") call.target?.navigate("https://example.com/cart");
      return {};
    });
    await perform("open", { url: "https://example.com/" });
    expect(await perform("click", { target: { selector: "a.cart" } })).toEqual({ ok: true, value: { url: "https://example.com/cart", title: "Your cart" } });
  });

  it("types by selector: clicks the field, selects all it holds, and inserts the text in its place", async () => {
    const { peer, perform } = await driven();
    withField(peer);
    await perform("open", { url: "https://example.com/" });
    expect(await perform("type", { target: { selector: "#email" }, text: "ada@example.com" })).toMatchObject({ ok: true });
    const calls = peer.sentOf("Runtime.callFunctionOn").map(({ params }) => String(params.functionDeclaration).match(/^function (\w+)/)?.[1]);
    expect(calls).toEqual(["locateElement", "selectFieldContents"]);
    expect(mouse(peer).map((event) => event.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    const order = peer.sent.map((command) => command.method);
    expect(order.lastIndexOf("Runtime.callFunctionOn")).toBeLessThan(order.indexOf("Input.insertText"));
    expect(peer.sentOf("Input.insertText")[0]?.params).toEqual({ text: "ada@example.com" });
  });

  it("clears the field when the text is empty", async () => {
    const { peer, perform } = await driven();
    withField(peer);
    await perform("open", { url: "https://example.com/" });
    expect(await perform("type", { target: { selector: "#search" }, text: "" })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.insertText")).toEqual([]);
    expect(peer.sentOf("Input.dispatchKeyEvent").map(({ params }) => [params.type, params.key])).toEqual([
      ["keyDown", "Delete"],
      ["keyUp", "Delete"],
    ]);
  });

  it("answers a sentence for a selector that matches nothing, one that is not valid, an element with nothing visible, and one that takes no text", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.inPage("locateElement", ({ args }) => {
      const { selector } = args[0] as { selector: string };
      return selector === "#missing"
        ? { kind: "none" }
        : selector === "p["
          ? { kind: "invalid", message: "'p[' is not a valid selector." }
          : selector === "#hidden"
            ? { kind: "hidden" }
            : selector === "#under"
              ? { kind: "covered", by: "div#banner.cookie" }
              : { kind: "found", x: 1, y: 1, editable: false };
    });
    expect(await perform("click", { target: { selector: "#missing" } })).toEqual({ ok: false, reason: "No element on the page matches the CSS selector #missing." });
    expect(await perform("click", { target: { selector: "p[" } })).toEqual({ ok: false, reason: "The CSS selector p[ is not valid: 'p[' is not a valid selector." });
    expect(await perform("click", { target: { selector: "#hidden" } })).toEqual({ ok: false, reason: "The element matching #hidden has no visible part on the page to act on." });
    expect(await perform("click", { target: { selector: "#under" } })).toEqual({
      ok: false,
      reason: "The element matching #under is covered at its centre by div#banner.cookie, which would take the click. Deal with that first, or click at a point.",
    });
    expect(await perform("type", { target: { selector: "#label" }, text: "x" })).toEqual({ ok: false, reason: "The element matching #label does not take typed text." });
    expect(mouse(peer)).toEqual([]);
  });

  it("says it cannot read a page as text yet", async () => {
    const { perform } = await driven();
    await perform("open", {});
    expect(await perform("read", {})).toEqual({ ok: false, reason: "This browser cannot read a page as text yet. Take a screenshot to see the page." });
  });
});

describe("click at a point, scroll and wait", () => {
  it("clicks at a point in screenshot pixels, and refuses one outside the screenshot", async () => {
    const { peer, perform } = await driven();
    await perform("open", {});
    expect(await perform("clickAt", { x: 1_279, y: 0 })).toMatchObject({ ok: true });
    expect(mouse(peer).map(({ type, x, y }) => [type, x, y])).toEqual([
      ["mouseMoved", 1_279, 0],
      ["mousePressed", 1_279, 0],
      ["mouseReleased", 1_279, 0],
    ]);
    expect(await perform("clickAt", { x: 1_280, y: 10 })).toEqual({ ok: false, reason: "The point (1280, 10) is outside the screenshot, which is 1280 by 800 pixels." });
    expect(await perform("clickAt", { x: 10, y: 800 })).toMatchObject({ ok: false });
  });

  it("scrolls by a direction and an amount in viewports, one viewport when none is given, with the wheel at the viewport's centre", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/long" });
    expect(await perform("scroll", { to: { direction: "down", amount: 2 } })).toEqual({ ok: true, value: { url: "https://example.com/long", title: "" } });
    await perform("scroll", { to: { direction: "up" } });
    await perform("scroll", { to: { direction: "left", amount: 0.5 } });
    await perform("scroll", { to: { direction: "right" } });
    expect(mouse(peer).map(({ x, y, deltaX, deltaY }) => [x, y, deltaX, deltaY])).toEqual([
      [640, 400, 0, 1_600],
      [640, 400, 0, -800],
      [640, 400, -640, 0],
      [640, 400, 1_280, 0],
    ]);
  });

  it("waits a number of milliseconds on the driver's clock", async () => {
    const clock = manualClock();
    const { perform } = await driven({ clock });
    await perform("open", {});
    let answered = false;
    const answer = perform("waitFor", { until: { ms: 5_000 } }).finally(() => (answered = true));
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    clock.advance(4_999);
    await Promise.resolve();
    expect(answered).toBe(false);
    clock.advance(1);
    expect(await answer).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
  });

  it("clamps a longer wait to 30 seconds and says so", async () => {
    const clock = manualClock();
    const { perform } = await driven({ clock });
    await perform("open", {});
    const answer = perform("waitFor", { until: { ms: 90_000 } });
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    clock.advance(30_000);
    expect(await answer).toEqual({ ok: true, value: { url: "about:blank", title: "" }, notice: "A wait is at most 30 seconds: the 90 seconds asked for were cut to 30 seconds." });
  });

  it("waits for text to appear in any frame, looking again until it does", async () => {
    const clock = manualClock();
    const { peer, perform } = await driven({ clock });
    await perform("open", {});
    let shown = false;
    peer.inPage("showsText", ({ args }) => shown && args[0] === "Order placed");
    const answer = perform("waitFor", { until: { text: "Order placed" } });
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    shown = true;
    clock.advance(250);
    expect(await answer).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
    expect(peer.sentOf("Runtime.callFunctionOn")).toHaveLength(2);
  });

  it("finds text only a cross-site frame shows, reading every frame of the page", async () => {
    const { peer, perform } = await driven();
    peer.document("https://shop.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    await perform("open", { url: "https://shop.example/" });
    peer.inPage("showsText", ({ frame, args }) => frame.url === "https://pay.example/embed" && args[0] === "Card accepted");
    expect(await perform("waitFor", { until: { text: "Card accepted" } })).toEqual({ ok: true, value: { url: "https://shop.example/", title: "" } });
  });

  it("answers a sentence when the text has not appeared by the bound, preset 10 seconds, and names a clamp", async () => {
    const clock = manualClock();
    const { peer, perform } = await driven({ clock });
    await perform("open", {});
    peer.inPage("showsText", () => false);
    const answer = perform("waitFor", { until: { text: "Never" } });
    for (let waited = 0; waited < 10_000; waited += 250) {
      await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
      clock.advance(250);
    }
    expect(await answer).toEqual({ ok: false, reason: '"Never" did not appear on the page within 10 seconds.' });

    const longer = perform("waitFor", { until: { text: "Never", timeoutMs: 45_000 } });
    for (let waited = 0; waited < 30_000; waited += 250) {
      await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
      clock.advance(250);
    }
    expect(await longer).toEqual({
      ok: false,
      reason: '"Never" did not appear on the page within 30 seconds. A wait is at most 30 seconds: the 45 seconds asked for were cut to 30 seconds.',
    });
  });

  it("says a longer ask was cut without claiming the whole bound was waited when the text came at once", async () => {
    const { peer, perform } = await driven();
    await perform("open", {});
    peer.inPage("showsText", () => true);
    expect(await perform("waitFor", { until: { text: "Ready", timeoutMs: 45_000 } })).toEqual({
      ok: true,
      value: { url: "about:blank", title: "" },
      notice: "A wait is at most 30 seconds: the 45 seconds asked for were cut to 30 seconds.",
    });
  });
});

describe("the deep verbs under the host's policy", () => {
  const at = Date.parse("2026-09-30T08:00:00.000Z");

  it("answers the console lines and uncaught errors since the last read, those logged before the first read included", async () => {
    const { peer, perform } = await driven({ kind: "headless" });
    await perform("open", { url: "https://example.com/" });
    // Chromium replays the console it kept when Runtime and Log are enabled.
    peer.answer("Runtime.enable", (call) => {
      call.emit("Runtime.consoleAPICalled", {
        type: "warning",
        args: [{ type: "string", value: "cart is" }, { type: "number", value: 3 }, { type: "object", description: "Object" }],
        timestamp: at,
        stackTrace: { callFrames: [{ url: "https://example.com/app.js", lineNumber: 41 }] },
      });
      call.emit("Runtime.exceptionThrown", {
        timestamp: at + 1,
        exceptionDetails: { text: "Uncaught", url: "https://example.com/app.js", lineNumber: 9, exception: { description: "TypeError: x is undefined" } },
      });
      return {};
    });
    peer.answer("Log.enable", (call) => {
      call.emit("Log.entryAdded", { entry: { source: "network", level: "error", text: "Failed to load resource: 404", timestamp: at + 2, url: "https://example.com/missing.png" } });
      return {};
    });
    expect(await perform("console", {})).toEqual({
      ok: true,
      value: [
        { level: "warn", text: "cart is 3 Object", source: "https://example.com/app.js:42", at: "2026-09-30T08:00:00.000Z" },
        { level: "exception", text: "TypeError: x is undefined", source: "https://example.com/app.js:10", at: "2026-09-30T08:00:00.001Z" },
        { level: "error", text: "Failed to load resource: 404", source: "https://example.com/missing.png:?", at: "2026-09-30T08:00:00.002Z" },
      ],
    });
    expect(await perform("console", {})).toEqual({ ok: true, value: [] });
  });

  it("keeps the latest 1,000 console lines between two reads, and says how many older ones went", async () => {
    const { peer, perform } = await driven({ kind: "headless" });
    await perform("open", {});
    peer.answer("Runtime.enable", (call) => {
      for (let n = 1; n <= 1_005; n++) call.emit("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: `line ${n}` }], timestamp: at });
      return {};
    });
    const answer = await perform("console", {});
    if (!answer.ok) throw new Error(answer.reason);
    expect(answer.value).toHaveLength(1_000);
    expect(answer.value[0]?.text).toBe("line 6");
    expect(answer.notice).toBe("The 5 oldest lines were dropped: the browser keeps the latest 1,000 between two reads.");
  });

  it("keeps the latest 1,000 requests between two reads, and says how many older ones went", async () => {
    const { peer, perform } = await driven({ kind: "headless", networkAtAttach: true });
    await perform("open", {});
    const session = peer.sentOf("Network.enable")[0]?.sessionId;
    for (let n = 1; n <= 1_003; n++) {
      peer.emit("Network.requestWillBeSent", { requestId: `r${n}`, request: { url: `https://example.com/${n}`, method: "GET" }, timestamp: 1, wallTime: at / 1_000, type: "Fetch" }, session);
    }
    // The peer's answer to a later command comes after the events it sent before it.
    await perform("screenshot", {});
    const answer = await perform("network", {});
    if (!answer.ok) throw new Error(answer.reason);
    expect([answer.value.length, answer.value[0]?.url, answer.notice]).toEqual([
      1_000,
      "https://example.com/4",
      "The 3 oldest requests were dropped: the browser keeps the latest 1,000 between two reads.",
    ]);
  });

  it("answers the requests since the last read, only the failed ones when asked, and says the first read starts the recording", async () => {
    const { peer, perform } = await driven({ kind: "headless" });
    await perform("open", { url: "https://example.com/" });
    expect(await perform("network", {})).toEqual({
      ok: true,
      value: [],
      notice: "The network is recorded from this call on: ask again after the page has done what you want to see.",
    });
    await perform("navigate", { url: "https://example.com/next" });
    const [session] = peer.sentOf("Network.enable").map((command) => command.sessionId);
    const request = (requestId: string, url: string) => peer.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET" }, timestamp: 10, wallTime: at / 1_000, type: "XHR" }, session);
    request("r1", "https://example.com/api/cart");
    peer.emit("Network.responseReceived", { requestId: "r1", timestamp: 10.25, type: "XHR", response: { url: "https://example.com/api/cart", status: 500 } }, session);
    peer.emit("Network.loadingFinished", { requestId: "r1", timestamp: 10.5 }, session);
    request("r2", "https://tracker.example/pixel");
    peer.emit("Network.loadingFailed", { requestId: "r2", timestamp: 10.1, errorText: "net::ERR_BLOCKED_BY_CLIENT", blockedReason: "inspector" }, session);
    request("r3", "https://example.com/ok.css");
    peer.emit("Network.responseReceived", { requestId: "r3", timestamp: 10, type: "Stylesheet", response: { url: "https://example.com/ok.css", status: 200 } }, session);
    await expect.poll(async () => ((await perform("network", { failedOnly: true })) as { value: unknown[] }).value, { timeout: 30_000 }).toEqual([
      { method: "GET", url: "https://example.com/api/cart", resourceType: "xhr", status: 500, durationMs: 500, at: "2026-09-30T08:00:00.000Z" },
      { method: "GET", url: "https://tracker.example/pixel", resourceType: "xhr", durationMs: expect.closeTo(100, 5), failure: "net::ERR_BLOCKED_BY_CLIENT (blocked: inspector)", at: "2026-09-30T08:00:00.000Z" },
    ]);
  });

  it("reads cookie values only where the page policy allows deep reads, and names the settings that would allow them elsewhere", async () => {
    const { peer, perform, setPolicy } = await driven();
    peer.answer("Network.getCookies", () => ({
      cookies: [
        { name: "sid", value: "value-for-tests", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true, session: true, sameSite: "Lax" },
        { name: "pref", value: "dark", domain: ".shop.example", path: "/", expires: at / 1_000, httpOnly: false, secure: false, session: false },
      ],
    }));
    await perform("open", { url: "https://shop.example/" });
    expect(await perform("cookies", {})).toEqual({
      ok: true,
      value: [
        { name: "sid", domain: "shop.example", path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
        { name: "pref", domain: ".shop.example", path: "/", expires: "2026-09-30T08:00:00.000Z", httpOnly: false, secure: false },
      ],
      notice: "Cookie values are left out: shop.example is not a dev site. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read them.",
    });
    expect(peer.sentOf("Network.getCookies")[0]?.params).toEqual({ urls: ["https://shop.example/"] });
    setPolicy({ ...plainPolicy, devSites: ["shop.example"] });
    expect(await perform("cookies", {})).toMatchObject({ ok: true, value: [{ name: "sid", value: "value-for-tests" }, { name: "pref", value: "dark" }] });
    setPolicy({ ...plainPolicy, deepReadEverywhere: true });
    expect(await perform("cookies", {})).toMatchObject({ ok: true, value: [{ value: "value-for-tests" }, { value: "dark" }] });
  });

  it("reads storage only where deep reads are allowed, else answers a sentence naming the settings", async () => {
    const { peer, perform, setPolicy } = await driven();
    peer.inPage("readStorage", () => ({ origin: "https://shop.example", local: { theme: "dark" }, session: {} }));
    await perform("open", { url: "https://shop.example/" });
    expect(await perform("storage", {})).toEqual({
      ok: false,
      reason: "Storage is read only on dev sites, and shop.example is not one. Add it to browser.devSites, or turn on browser.deepReadEverywhere, to read it.",
    });
    expect(enabledDomains(peer)).toEqual(["Page.enable"]);
    setPolicy({ ...plainPolicy, deepReadEverywhere: true });
    expect(await perform("storage", {})).toEqual({ ok: true, value: { origin: "https://shop.example", local: { theme: "dark" }, session: {} } });
  });

  it("evaluates only where the policy allows it, in the page's own world, and answers what the expression threw as a sentence", async () => {
    const { peer, perform, setPolicy } = await driven();
    await perform("open", { url: "https://shop.example/" });
    expect(await perform("evaluate", { expression: "document.cookie" })).toEqual({
      ok: false,
      reason: "evaluate runs only on dev sites, and shop.example is not one. Add it to browser.devSites, or turn on browser.evaluateEverywhere, to run it.",
    });
    expect(peer.sentOf("Runtime.evaluate")).toEqual([]);
    setPolicy({ ...plainPolicy, evaluateEverywhere: true });
    peer.answer("Runtime.evaluate", (call) =>
      call.params.expression === "boom()"
        ? { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } }
        : { result: { type: "object", value: { items: 3 } } },
    );
    expect(await perform("evaluate", { expression: "window.store.cart" })).toEqual({ ok: true, value: { result: { items: 3 } } });
    expect(peer.sentOf("Runtime.evaluate")[0]?.params).toEqual({ expression: "window.store.cart", returnByValue: true, awaitPromise: true });
    expect(peer.sentOf("Runtime.evaluate")[0]?.params).not.toHaveProperty("contextId");
    expect(await perform("evaluate", { expression: "boom()" })).toEqual({ ok: false, reason: "The expression threw: ReferenceError: boom is not defined" });
  });

  it("gives the headless browser every deep verb on every site: it is signed in to nothing", async () => {
    const { peer, perform } = await driven({ kind: "headless" });
    peer.answer("Network.getCookies", () => ({ cookies: [{ name: "sid", value: "value-for-tests", domain: "shop.example", path: "/", expires: -1, httpOnly: true, secure: true, session: true }] }));
    await perform("open", { url: "https://shop.example/" });
    expect(await perform("cookies", {})).toEqual({ ok: true, value: [{ name: "sid", value: "value-for-tests", domain: "shop.example", path: "/", httpOnly: true, secure: true }] });
    expect(await perform("storage", {})).toMatchObject({ ok: true });
    expect(await perform("evaluate", { expression: "1" })).toMatchObject({ ok: true });
  });

  it("gives the dock none of the deep verbs", async () => {
    const { peer, perform } = await driven({ kind: "dock" });
    await perform("open", { url: "http://localhost:3000/" });
    for (const verb of ["console", "network", "cookies", "storage", "evaluate"] as const) {
      expect(await perform(verb, (verb === "evaluate" ? { expression: "1" } : {}) as never)).toEqual({
        ok: false,
        reason: `The browser dock has no ${verb} verb: it reads and acts on pages, without the developer tools' console, network, cookies, storage or evaluate.`,
      });
    }
    expect(peer.sentOf("Network.getCookies")).toEqual([]);
  });
});

describe("letting go of a page, and a page that has gone", () => {
  it("detaches the driver when it lets go, and tells the host, which keeps the page", async () => {
    const { peer, perform, host } = await driven();
    await perform("open", { url: "https://example.com/" });
    const { targetId } = peer.targets()[0] as { targetId: string };
    expect(await perform("close", {})).toEqual({ ok: true, value: null });
    expect(peer.sentOf("Target.detachFromTarget")).toHaveLength(1);
    expect(host.released).toEqual([PAGE]);
    expect(peer.targets().map((target) => target.targetId)).toEqual([targetId]);
    // Letting go of a page it does not hold is no error.
    expect(await perform("close", {})).toEqual({ ok: true, value: null });
  });

  it("answers a verb for a session with no page with a sentence", async () => {
    const { perform } = await driven();
    expect(await perform("screenshot", {})).toEqual({ ok: false, reason: "No page is open for this session. Open one with browser_open first." });
  });

  it("answers a sentence, never throwing, for a verb on a page whose tab was closed, and opens a new page after", async () => {
    const { perform, page } = await driven();
    await perform("open", { url: "https://example.com/" });
    page().close();
    expect(await perform("screenshot", {})).toEqual({ ok: false, reason: "The page this session had is gone (the target was detached or closed). Open it again with browser_open." });
    expect(await perform("open", {})).toMatchObject({ ok: true, value: { url: "about:blank" } });
  });

  it("answers a sentence for a verb in flight when the page goes, and for one on a page that crashed", async () => {
    const { peer, perform, page } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.answer("Page.captureScreenshot", () => new Promise(() => undefined));
    const inFlight = perform("screenshot", {});
    await expect.poll(() => peer.sentOf("Page.captureScreenshot").length, { timeout: 30_000 }).toBe(1);
    page().close();
    expect(await inFlight).toEqual({ ok: false, reason: "The page this session had is gone (the target was detached or closed). Open it again with browser_open." });

    await perform("open", {});
    page().crash();
    await expect.poll(() => perform("screenshot", {}), { timeout: 30_000 }).toEqual({ ok: false, reason: "The page this session had is gone (the page crashed). Open it again with browser_open." });
  });

  it("answers a sentence when the browser itself goes away", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.disconnect();
    await expect.poll(() => perform("screenshot", {}), { timeout: 30_000 }).toMatchObject({ ok: false, reason: expect.stringMatching(/^The page this session had is gone \(the browser connection closed/) });
  });

  it("answers the host's own sentence when it cannot give a page", async () => {
    const blocked = cdpPageDriver({
      kind: "chrome",
      policy: () => plainPolicy,
      host: {
        attach: async () => {
          throw new Error("This Chrome's administrator has turned the debugger off, so the extension cannot drive a page here.");
        },
      },
    });
    expect(await blocked.perform({ pageKey: PAGE, command: { verb: "open", args: {} } })).toEqual({
      ok: false,
      reason: "This Chrome's administrator has turned the debugger off, so the extension cannot drive a page here.",
    });
  });
});

describe("dialogs", () => {
  it("answers a dialog the page opens, as a person would, and says so beside the verb's answer", async () => {
    const { peer, perform } = await driven();
    withField(peer, false);
    await perform("open", { url: "https://example.com/" });
    peer.answer("Input.dispatchMouseEvent", (call) => {
      if (call.params.type === "mouseReleased") call.emit("Page.javascriptDialogOpening", { url: "https://example.com/", message: "Delete this item?", type: "confirm" });
      return {};
    });
    expect(await perform("click", { target: { selector: "#delete" } })).toEqual({
      ok: true,
      value: { url: "https://example.com/", title: "" },
      notice: 'The page showed a confirm dialog saying "Delete this item?", which the browser dismissed.',
    });
    expect(peer.sentOf("Page.handleJavaScriptDialog")[0]?.params).toEqual({ accept: false });
  });
});

describe("the frame judge", () => {
  const paypal = listed("*.paypal.com", "preset:paypal");
  const guarded = { ...plainPolicy, browserDomains: [paypal] };
  const blanked = (peer: Driven["peer"]) => peer.sentOf("Page.navigate").filter(({ params }) => params.url === "about:blank").length;

  it("refuses an address the verb names that the denylist lists, before any load, with the entry", async () => {
    const { peer, perform } = await driven({ policy: guarded });
    await perform("open", {});
    expect(await perform("navigate", { url: "https://www.paypal.com/signin" })).toEqual({
      ok: false,
      reason: "https://www.paypal.com/signin is on the denylist's browser section (*.paypal.com), so the browser did not open it. Only the person can allow it.",
      denylist: { frame: "top-level", match: { section: "browserDomains", entry: paypal, matched: "https://www.paypal.com/signin" } },
    });
    expect(peer.sentOf("Page.navigate")).toEqual([]);
  });

  it("holds a redirect into a listed domain: the page goes to about:blank, and the verb answers the address and the entry", async () => {
    const { peer, perform } = await driven({ policy: guarded });
    peer.document("https://shop.example/pay", { redirect: "https://www.paypal.com/checkout" });
    expect(await perform("open", { url: "https://shop.example/pay" })).toEqual({
      ok: false,
      reason: "The page went to https://www.paypal.com/checkout, which the denylist's browser section lists (*.paypal.com), so it was stopped at about:blank. Only the person can allow it.",
      denylist: { frame: "top-level", match: { section: "browserDomains", entry: paypal, matched: "https://www.paypal.com/checkout" } },
    });
    expect(blanked(peer)).toBe(1);
    expect(await perform("open", {})).toEqual({ ok: true, value: { url: "about:blank", title: "" } });
  });

  it("holds a navigation a click started, and one a script started between two verbs, which the next verb answers", async () => {
    const { peer, perform, page } = await driven({ policy: guarded });
    withField(peer, false);
    peer.answer("Input.dispatchMouseEvent", (call) => {
      if (call.params.type === "mouseReleased") call.target?.navigate("https://www.paypal.com/pay");
      return {};
    });
    await perform("open", { url: "https://shop.example/" });
    expect(await perform("click", { target: { selector: "a.pay" } })).toMatchObject({
      ok: false,
      denylist: { frame: "top-level", match: { matched: "https://www.paypal.com/pay" } },
    });

    await perform("navigate", { url: "https://shop.example/" });
    page().navigate("https://paypal.com/");
    await expect.poll(() => blanked(peer), { timeout: 30_000 }).toBe(2);
    expect(await perform("screenshot", {})).toMatchObject({ ok: false, denylist: { frame: "top-level", match: { matched: "https://paypal.com/" } } });
    expect(await perform("screenshot", {})).toMatchObject({ ok: true });
  });

  it.each([
    ["in the page's own process", false],
    ["in a child target", true],
  ])("refuses the page whole when a sub-frame %s loads a listed domain, naming the frame and the entry", async (_where, crossSite) => {
    const { peer, perform } = await driven({ policy: guarded });
    peer.document("https://shop.example/checkout", { frames: [{ url: "https://www.paypal.com/sdk/frame", crossSite }] });
    expect(await perform("open", { url: "https://shop.example/checkout" })).toEqual({
      ok: false,
      reason: "A frame of the page loaded https://www.paypal.com/sdk/frame, which the denylist's browser section lists (*.paypal.com), so the whole page was stopped at about:blank.",
      denylist: { frame: "sub-frame", match: { section: "browserDomains", entry: paypal, matched: "https://www.paypal.com/sdk/frame" } },
    });
    expect(blanked(peer)).toBe(1);
  });

  it("judges each arrival by the policy the host holds then, so a changed policy counts at once", async () => {
    const { peer, perform, setPolicy, page } = await driven();
    await perform("open", { url: "https://shop.example/" });
    setPolicy({ ...plainPolicy, browserDomains: [listed("shop.example")] });
    page().addFrame("https://shop.example/embed");
    await expect.poll(() => blanked(peer), { timeout: 30_000 }).toBe(1);
    expect(await perform("screenshot", {})).toMatchObject({ ok: false, denylist: { frame: "sub-frame" } });
  });

  it("judges the address each frame has now before every verb, so a policy that came to list the page refuses the next verb with the address and the entry", async () => {
    const { peer, perform, setPolicy } = await driven();
    await perform("open", { url: "https://shop.example/" });
    setPolicy({ ...plainPolicy, browserDomains: [listed("shop.example")] });
    expect(await perform("screenshot", {})).toEqual({
      ok: false,
      reason: "The page is at https://shop.example/, which the denylist's browser section lists (shop.example), so it was stopped at about:blank. Only the person can allow it.",
      denylist: { frame: "top-level", match: { section: "browserDomains", entry: listed("shop.example"), matched: "https://shop.example/" } },
    });

    setPolicy(plainPolicy);
    peer.document("https://news.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    expect(await perform("navigate", { url: "https://news.example/" })).toMatchObject({ ok: true });
    setPolicy({ ...plainPolicy, browserDomains: [listed("pay.example")] });
    expect(await perform("screenshot", {})).toEqual({
      ok: false,
      reason: "A frame of the page is at https://pay.example/embed, which the denylist's browser section lists (pay.example), so the whole page was stopped at about:blank.",
      denylist: { frame: "sub-frame", match: { section: "browserDomains", entry: listed("pay.example"), matched: "https://pay.example/embed" } },
    });
    await expect.poll(() => blanked(peer), { timeout: 20_000 }).toBe(2);
    expect(await perform("screenshot", {})).toMatchObject({ ok: true });
  });

  it("opens the host a one-time allowance names, once: its frames stand while it is the page, and the next arrival there is judged afresh", async () => {
    const { peer, perform, page } = await driven({ policy: guarded });
    peer.document("https://www.paypal.com/signin", { title: "Log in", frames: [{ url: "https://www.paypal.com/risk", crossSite: true }] });
    const allowance = { host: "www.paypal.com" };
    await perform("open", {});
    expect(await perform("navigate", { url: "https://www.paypal.com/signin" }, { allowance })).toEqual({
      ok: true,
      value: { url: "https://www.paypal.com/signin", title: "Log in" },
    });
    expect(await perform("screenshot", {})).toMatchObject({ ok: true });
    // The page moves on within the host by itself: the allowance was spent on the load it opened.
    page().navigate("https://www.paypal.com/summary");
    await expect.poll(() => blanked(peer), { timeout: 30_000 }).toBe(1);
    expect(await perform("screenshot", {})).toMatchObject({ ok: false, denylist: { frame: "top-level", match: { matched: "https://www.paypal.com/summary" } } });
    expect(await perform("navigate", { url: "https://www.paypal.com/signin" })).toMatchObject({ ok: false, denylist: { frame: "top-level" } });
  });

  it("spends an allowance on its own host only: a redirect to another listed host is still held", async () => {
    const { peer, perform } = await driven({ policy: guarded });
    peer.document("https://www.paypal.com/go", { redirect: "https://checkout.paypal.com/" });
    await perform("open", {});
    expect(await perform("navigate", { url: "https://www.paypal.com/go" }, { allowance: { host: "www.paypal.com" } })).toMatchObject({
      ok: false,
      denylist: { frame: "top-level", match: { matched: "https://checkout.paypal.com/" } },
    });
  });

  it("puts every frame's arrival to the host's own rule, with the address it was served from while Network is on", async () => {
    const arrivals: unknown[] = [];
    const rule = (arrival: { url: string; topLevel: boolean; servedFrom?: string }) => {
      arrivals.push(arrival);
      return arrival.servedFrom?.startsWith("10.") ? `${arrival.url} was served from ${arrival.servedFrom}, an internal address.` : null;
    };
    const { peer, perform } = await driven({ kind: "headless", networkAtAttach: true, addressRule: rule });
    peer.document("https://news.example/", { frames: [{ url: "https://widgets.example/w", crossSite: true }] });
    peer.document("https://rebinding.example/", { servedFrom: "10.0.0.5" });
    expect(await perform("open", { url: "https://news.example/" })).toMatchObject({ ok: true });
    expect(arrivals).toEqual(
      expect.arrayContaining([
        { url: "https://news.example/", topLevel: true },
        { url: "https://news.example/", topLevel: true, servedFrom: "93.184.215.14" },
        { url: "https://widgets.example/w", topLevel: false, servedFrom: "93.184.215.14" },
      ]),
    );
    expect(await perform("navigate", { url: "https://rebinding.example/" })).toEqual({
      ok: false,
      reason: "https://rebinding.example/ was served from 10.0.0.5, an internal address. The page was stopped at about:blank.",
    });
  });

  it("puts an address the agent named to the host's own check before the browser opens it, after the denylist, and opens nothing it refuses", async () => {
    const checked: string[] = [];
    const beforeNavigation = async (url: string) => {
      checked.push(url);
      return url.includes("intranet") ? `${url} resolves to 10.0.0.5, a private address.` : null;
    };
    const { peer, perform } = await driven({ kind: "headless", policy: { ...plainPolicy, browserDomains: [listed("paypal.com")] }, beforeNavigation });
    expect(await perform("open", { url: "intranet.example" })).toEqual({ ok: false, reason: "https://intranet.example resolves to 10.0.0.5, a private address." });
    expect(await perform("navigate", { url: "https://paypal.com/" })).toMatchObject({ ok: false, denylist: { frame: "top-level" } });
    expect(peer.sentOf("Page.navigate")).toEqual([]);
    expect(await perform("navigate", { url: "https://news.example/" })).toMatchObject({ ok: true, value: { url: "https://news.example/" } });
    expect(checked).toEqual(["https://intranet.example", "https://news.example/"]);
  });

  it("gives the host's rule a document no server served with no address, not the one the frame's last document came from", async () => {
    const arrivals: FrameArrival[] = [];
    // The host lists intranet.example as internal: another address served from 10.x is refused.
    const rule = (arrival: FrameArrival) => {
      arrivals.push(arrival);
      const internal = arrival.servedFrom?.startsWith("10.") === true && !arrival.url.startsWith("https://intranet.example/");
      return internal ? `${arrival.url} was served from ${String(arrival.servedFrom)}, an internal address.` : null;
    };
    const { peer, perform, page } = await driven({ kind: "headless", networkAtAttach: true, addressRule: rule });
    peer.document("https://intranet.example/", { servedFrom: "10.0.0.5" });
    expect(await perform("open", { url: "https://intranet.example/" })).toMatchObject({ ok: true });
    expect(arrivals.at(-1)).toEqual({ url: "https://intranet.example/", topLevel: true, servedFrom: "10.0.0.5" });
    // A script on the page sends it to about:blank, which no server serves.
    page().navigate("about:blank");
    await expect.poll(() => arrivals.at(-1)?.url, { timeout: 30_000 }).toBe("about:blank");
    expect(arrivals.at(-1)).toEqual({ url: "about:blank", topLevel: true });
    expect(await perform("screenshot", {})).toMatchObject({ ok: true });
  });

  it("refuses the Chrome Web Store in a Chrome only, where Chrome lets no extension act", async () => {
    const chrome = await driven();
    await chrome.perform("open", {});
    expect(await chrome.perform("navigate", { url: "https://chromewebstore.google.com/" })).toEqual({
      ok: false,
      reason: "https://chromewebstore.google.com/ is on the Chrome Web Store, where Chrome lets no extension read or act, so the browser did not open it.",
    });
    const headless = await driven({ kind: "headless" });
    await headless.perform("open", {});
    expect(await headless.perform("navigate", { url: "https://chromewebstore.google.com/" })).toMatchObject({ ok: true });
  });
});
