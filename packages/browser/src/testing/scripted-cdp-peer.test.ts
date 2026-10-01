import { describe, expect, it, onTestFinished } from "vitest";
import { cdpConnection } from "../cdp/connection.js";
import { webSocketTransport } from "../cdp/web-socket.js";
import { scriptedCdpPeer } from "./index.js";

/**
 * The scripted CDP peer as the tests of other packages meet it: its
 * DevTools address found as a browser's is, and in-page functions answered
 * by name in the world and frame they were called in.
 */

const listening = async () => {
  const peer = scriptedCdpPeer();
  onTestFinished(() => peer.close());
  const url = await peer.listen();
  return { peer, url };
};

describe("the scripted CDP peer", () => {
  it("answers /json/version with its DevTools address, as a browser's endpoint does", async () => {
    const { url } = await listening();
    const version = (await (await fetch(new URL("/json/version", url.replace(/^ws/, "http")))).json()) as { webSocketDebuggerUrl: string };
    expect(version.webSocketDebuggerUrl).toBe(url);
  });

  it("reports a frame's origin as Chromium does, an opaque one as ://", async () => {
    const { peer, url } = await listening();
    const connection = cdpConnection(await webSocketTransport(url));
    onTestFinished(() => connection.close());
    const origin = async (target: string) => {
      const { frameTree } = await (await connection.attach(target)).send("Page.getFrameTree");
      return (frameTree as { frame: { securityOrigin: string } }).frame.securityOrigin;
    };
    expect(await origin(peer.createPage().targetId)).toBe("://");
    expect(await origin(peer.createPage("https://example.com/app").targetId)).toBe("https://example.com");
  });

  it("answers an in-page function by its name in the frame whose world it was called in, and refuses a world whose document went", async () => {
    const { peer, url } = await listening();
    const connection = cdpConnection(await webSocketTransport(url));
    onTestFinished(() => connection.close());
    const page = peer.createPage("https://example.com/");
    const session = await connection.attach(page.targetId);
    peer.inPage("pageTitle", ({ frame, args, worldName }) => `${frame.url} ${String(args[0])} ${worldName}`);
    const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: page.targetId, worldName: "tests" });
    const call = () =>
      session.send("Runtime.callFunctionOn", {
        functionDeclaration: "function pageTitle(suffix) { return document.title + suffix; }",
        executionContextId,
        arguments: [{ value: "!" }],
        returnByValue: true,
      });
    expect(await call()).toEqual({ result: { type: "string", value: "https://example.com/ ! tests" } });
    page.navigate("https://example.com/next");
    await expect(call()).rejects.toThrow("Cannot find context with specified id");
  });

  it("sends a document's request and response for a fetched address only: about:blank, which nothing serves, commits with none", async () => {
    const { peer, url } = await listening();
    const connection = cdpConnection(await webSocketTransport(url));
    onTestFinished(() => connection.close());
    const page = peer.createPage();
    const session = await connection.attach(page.targetId);
    const heard: string[] = [];
    session.onEvent(({ method, params }) => {
      if (method === "Page.frameNavigated") heard.push(`${method} ${(params.frame as { url: string }).url}`);
      else if (method.startsWith("Network.") || method === "Page.frameStoppedLoading") heard.push(method);
    });
    const loadsStopped = () => heard.filter((method) => method === "Page.frameStoppedLoading").length;
    await session.send("Page.enable");
    await session.send("Network.enable");
    page.navigate("https://example.com/");
    await expect.poll(() => heard.at(-1), { timeout: 30_000 }).toBe("Network.loadingFinished");
    page.navigate("about:blank");
    await expect.poll(loadsStopped, { timeout: 30_000 }).toBe(2);
    expect(heard).toEqual([
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Page.frameNavigated https://example.com/",
      "Page.frameStoppedLoading",
      "Network.loadingFinished",
      "Page.frameNavigated about:blank",
      "Page.frameStoppedLoading",
    ]);
  });
});
