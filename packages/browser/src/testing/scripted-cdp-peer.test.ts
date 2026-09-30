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
});
