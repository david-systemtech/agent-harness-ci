import { describe, expect, it } from "vitest";
import { driven } from "../../test/driven.js";

describe("scrolling at a viewport point", () => {
  it.each([
    ["up", 0, -300], ["down", 0, 300], ["left", -300, 0], ["right", 300, 0],
  ] as const)("scrolls %s at the named point, three wheel notches by default", async (scroll_direction, deltaX, deltaY) => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    expect(await perform("scroll", { target: { type: "coordinate", x: 50, y: 70 }, scroll_direction })).toMatchObject({ ok: true });
    expect(peer.sentOf("Input.dispatchMouseEvent").at(-1)?.params).toEqual({ type: "mouseWheel", x: 50, y: 70, deltaX, deltaY });
  });

  it("scrolls a ref into view and refuses a stale ref", async () => {
    const { peer, perform } = await driven();
    peer.inPage("snapshotFrame", () => ({ nodes: [], lastRef: 1 }));
    peer.inPage("scrollToElement", () => "scrolled");
    await perform("open", { url: "https://example.com/" });
    await perform("snapshot", {});
    expect(await perform("scroll_to", { target: { type: "ref", ref: "e1" } })).toMatchObject({ ok: true });
    peer.inPage("scrollToElement", () => "stale");
    expect(await perform("scroll_to", { target: { type: "ref", ref: "e2" } })).toMatchObject({ ok: false, reason: expect.stringContaining("Take a new snapshot") });
  });
});

describe("zoom capture", () => {
  it("crops an upscaled region in page coordinates after scrolling, without changing viewport coordinates", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.answer("Page.getLayoutMetrics", () => ({ cssLayoutViewport: { pageX: 20, pageY: 600 } }));
    expect(await perform("zoom", { region: [100, 50, 300, 150] })).toMatchObject({ ok: true, value: { mimeType: "image/jpeg" } });
    expect(peer.sentOf("Page.captureScreenshot").at(-1)?.params).toEqual({ format: "jpeg", quality: 70, clip: { x: 120, y: 650, width: 200, height: 100, scale: 2 }, captureBeyondViewport: false });
    expect(peer.sentOf("Emulation.setDeviceMetricsOverride")).toHaveLength(1);
  });

  it("refuses empty, reversed or out-of-viewport regions before capture", async () => {
    const { peer, perform } = await driven();
    await perform("open", { url: "https://example.com/" });
    for (const region of [[100, 50, 100, 150], [300, 50, 100, 150], [100, 50, 1400, 150]] as [number, number, number, number][]) {
      expect(await perform("zoom", { region })).toMatchObject({ ok: false });
    }
    expect(peer.sentOf("Page.captureScreenshot")).toHaveLength(0);
  });
});

describe("history navigation", () => {
  it.each([['back', 1, 10, 'before'], ['forward', 1, 12, 'after']] as const)("%s chooses the adjacent history entry and settles its load", async (url, currentIndex, entryId, path) => {
    const { peer, perform, page } = await driven();
    await perform("open", { url: "https://example.com/current" });
    peer.answer("Page.getNavigationHistory", () => ({ currentIndex, entries: [
      { id: 10, url: "https://example.com/before", title: "Before" },
      { id: 11, url: "https://example.com/current", title: "Current" },
      { id: 12, url: "https://example.com/after", title: "After" },
    ] }));
    peer.answer("Page.navigateToHistoryEntry", () => { page().navigate(`https://example.com/${path}`); return {}; });
    expect(await perform("navigate", { url })).toMatchObject({ ok: true });
    expect(peer.sentOf("Page.navigateToHistoryEntry").at(-1)?.params).toEqual({ entryId });
    expect(page().url).toBe(`https://example.com/${path}`);
    expect(peer.sentOf("Page.navigate")).toHaveLength(1);
  });

  it("reloads the page and refuses missing history without treating keywords as hosts", async () => {
    const { peer, perform, page } = await driven();
    await perform("open", { url: "https://example.com/" });
    peer.answer("Page.reload", () => { page().navigate("https://example.com/"); return {}; });
    expect(await perform("navigate", { url: "reload" })).toMatchObject({ ok: true });
    expect(peer.sentOf("Page.reload")).toHaveLength(1);
    expect(await perform("navigate", { url: "back" })).toMatchObject({ ok: false, reason: expect.stringContaining("history") });
    expect(await perform("navigate", { url: "forward" })).toMatchObject({ ok: false });
    expect(peer.sentOf("Page.navigate")).toHaveLength(1);
  });

  it("runs history URLs through the host's preflight policy before sending any navigation", async () => {
    const checked: string[] = [];
    const { peer, perform } = await driven({ beforeNavigation: async (url) => { checked.push(url); return url.endsWith('/private') ? 'Private destination refused.' : null; } });
    await perform("open", { url: "https://example.com/current" });
    peer.answer("Page.getNavigationHistory", () => ({ currentIndex: 1, entries: [
      { id: 1, url: "https://example.com/private", title: "Private" },
      { id: 2, url: "https://example.com/current", title: "Current" },
    ] }));
    expect(await perform("navigate", { url: "back" })).toEqual({ ok: false, reason: 'Private destination refused.' });
    expect(checked).toEqual(['https://example.com/current', 'https://example.com/private']);
    expect(peer.sentOf("Page.navigateToHistoryEntry")).toHaveLength(0);
  });
});
