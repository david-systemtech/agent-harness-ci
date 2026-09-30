import { afterEach, describe, expect, it } from "vitest";
import { scriptedCdpPeer, type ScriptedCdpPeer } from "../testing/index.js";
import { cdpConnection, type CdpConnection } from "./connection.js";
import { pipeTransport } from "./pipe.js";
import { CdpError, type CdpEvent } from "./session.js";
import { webSocketTransport } from "./web-socket.js";

/**
 * The CDP session interface over a real wire (browser spec, "One page driver
 * for three browsers"): a connection to a whole browser over a loopback
 * WebSocket or a pipe, a session per page target in flat mode, commands to
 * the page's target or a child target, and their events.
 */

const peers: ScriptedCdpPeer[] = [];
afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.close();
});

const wires = {
  "a loopback WebSocket": async (peer: ScriptedCdpPeer) => cdpConnection(await webSocketTransport(await peer.listen())),
  "a pipe": async (peer: ScriptedCdpPeer) => cdpConnection(pipeTransport(peer.pipe())),
} as const;

const started = async (wire: keyof typeof wires): Promise<{ peer: ScriptedCdpPeer; connection: CdpConnection }> => {
  const peer = scriptedCdpPeer();
  peers.push(peer);
  return { peer, connection: await wires[wire](peer) };
};

/** Events heard until `until` holds of one. */
const hear = (subscribe: (listener: (event: CdpEvent) => void) => () => void, until: (event: CdpEvent) => boolean): Promise<CdpEvent[]> =>
  new Promise((resolve) => {
    const heard: CdpEvent[] = [];
    const stop = subscribe((event) => {
      heard.push(event);
      if (until(event)) {
        stop();
        resolve(heard);
      }
    });
  });

describe.each(Object.keys(wires) as (keyof typeof wires)[])("a CDP connection over %s", (wire) => {
  it("attaches to a page target, sends it commands and hears its events, and the peer records what it was sent", async () => {
    const { peer, connection } = await started(wire);
    const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
    const session = await connection.attach(targetId as string);
    await session.send("Page.enable");
    const loaded = hear(session.onEvent.bind(session), (event) => event.method === "Page.loadEventFired");
    const { loaderId } = await session.send("Page.navigate", { url: "https://example.com/" });
    const events = await loaded;

    expect(events.map((event) => event.method)).toEqual(["Page.frameStartedLoading", "Page.frameNavigated", "Page.domContentEventFired", "Page.loadEventFired"]);
    // The page's own target's events carry no session id; the driver never learns the page's.
    expect(events.every((event) => event.sessionId === undefined)).toBe(true);
    expect(events[1]?.params).toMatchObject({ frame: { id: targetId, url: "https://example.com/", loaderId } });
    expect(peer.sent.map(({ method, targetId: target }) => [method, target])).toEqual([
      ["Target.createTarget", undefined],
      ["Target.attachToTarget", undefined],
      ["Page.enable", targetId],
      ["Page.navigate", targetId],
    ]);
    expect(peer.sentOf("Target.attachToTarget")[0]?.params).toEqual({ targetId, flatten: true });
  });

  it("reaches a cross-site frame's child target by the session id its attachment gave, and hears its events with that id", async () => {
    const { peer, connection } = await started(wire);
    peer.document("https://shop.example/", { frames: [{ url: "https://pay.example/embed", crossSite: true }] });
    const page = peer.createPage("https://shop.example/");
    const session = await connection.attach(page.targetId);
    const attached = hear(session.onEvent.bind(session), (event) => event.method === "Target.attachedToTarget");
    await session.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const [attachment] = await attached;
    const child = attachment?.params.sessionId as string;
    expect(attachment?.params).toMatchObject({ targetInfo: { type: "iframe", url: "https://pay.example/embed" }, waitingForDebugger: true });

    await session.send("Page.enable", {}, child);
    const navigated = hear(session.onEvent.bind(session), (event) => event.method === "Page.frameNavigated");
    await session.send("Runtime.runIfWaitingForDebugger", {}, child);
    const [committed] = await navigated;
    expect(committed).toMatchObject({ sessionId: child, params: { frame: { url: "https://pay.example/embed" } } });
    const { frameTree } = await session.send("Page.getFrameTree", {}, child);
    expect(frameTree).toMatchObject({ frame: { id: page.children[0]?.targetId, url: "https://pay.example/embed" } });
    expect(peer.sentOf("Page.getFrameTree")[0]).toMatchObject({ sessionId: child, targetId: page.children[0]?.targetId });
  });

  it("refuses a session id that is not one of the page's child targets", async () => {
    const { connection } = await started(wire);
    const first = await connection.attach((await connection.send("Target.createTarget", {})).targetId as string);
    const other = await connection.send("Target.attachToTarget", { targetId: (await connection.send("Target.createTarget", {})).targetId, flatten: true });
    await expect(first.send("Page.enable", {}, other.sessionId as string)).rejects.toThrow(CdpError);
  });

  it("answers a protocol error as a CdpError carrying its message and code", async () => {
    const { connection } = await started(wire);
    const session = await connection.attach((await connection.send("Target.createTarget", {})).targetId as string);
    const failure = await session.send("Page.noSuchMethod").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CdpError);
    expect(failure).toMatchObject({ code: -32601, message: "Page.noSuchMethod: 'Page.noSuchMethod' wasn't found" });
  });

  it("ends a page's session when its target closes: detach heard once, and every later command refused", async () => {
    const { peer, connection } = await started(wire);
    const page = peer.createPage();
    const session = await connection.attach(page.targetId);
    const detached = new Promise<string>((resolve) => session.onDetach(resolve));
    page.close();
    expect(await detached).toMatch(/detached or closed/);
    await expect(session.send("Page.enable")).rejects.toThrow(/gone/);
  });

  it("ends every session and refuses what was owed when the browser goes away", async () => {
    const { peer, connection } = await started(wire);
    const session = await connection.attach(peer.createPage().targetId);
    peer.answer("Page.captureScreenshot", () => new Promise(() => undefined));
    const owed = session.send("Page.captureScreenshot");
    const detached = new Promise<string>((resolve) => session.onDetach(resolve));
    const closed = new Promise<string>((resolve) => connection.onClose(resolve));
    // The command reaches the peer before it goes.
    await expect.poll(() => peer.sentOf("Page.captureScreenshot").length, { timeout: 30_000 }).toBe(1);
    peer.disconnect();
    await expect(owed).rejects.toThrow(/connection closed/);
    expect(await detached).toMatch(/connection closed/);
    expect(await closed).not.toBe("");
    await expect(connection.send("Browser.getVersion")).rejects.toThrow(/connection closed/);
  });
});

describe("a pipe transport", () => {
  it("cuts each message at its NUL however the bytes were chunked, a character split across two chunks included", async () => {
    const peer = scriptedCdpPeer();
    peers.push(peer);
    peer.document("https://example.com/", { title: "Ça marche — 日本語 ✓" });
    const connection = cdpConnection(pipeTransport(peer.pipe({ chunkBytes: 3 })));
    const session = await connection.attach((await connection.send("Target.createTarget", { url: "https://example.com/" })).targetId as string);
    const { entries } = await session.send("Page.getNavigationHistory");
    expect(entries).toEqual([expect.objectContaining({ url: "https://example.com/", title: "Ça marche — 日本語 ✓" })]);
  });
});

describe("a WebSocket transport", () => {
  it("rejects with the address when nothing answers there", async () => {
    const peer = scriptedCdpPeer();
    peers.push(peer);
    const url = await peer.listen();
    await expect(webSocketTransport(url.replace(/browser\/.*$/, "browser/not-this-one"))).rejects.toThrow(/Could not open a CDP WebSocket to ws:\/\/127\.0\.0\.1/);
  });
});
