import { describe, expect, it, onTestFinished } from "vitest";
import { plainPolicy } from "../../test/driven.js";
import { cdpConnection } from "../cdp/connection.js";
import { webSocketTransport } from "../cdp/web-socket.js";
import { CdpFailure, scriptedCdpPeer } from "../testing/index.js";
import { showsText } from "./in-page.js";
import { CdpPage, systemDriverClock } from "./page.js";

/**
 * A page's frames as the driver stitches them (browser spec, "One page
 * driver for three browsers"): its own frames and its cross-site frames'
 * child targets, each frame with its own isolated world, and an in-page
 * function's answers keyed by frame, as the snapshot and the reader read
 * every frame (#544, #545).
 */

const attached = async () => {
  const peer = scriptedCdpPeer();
  const connection = cdpConnection(await webSocketTransport(await peer.listen()));
  onTestFinished(async () => {
    connection.close();
    await peer.close();
  });
  const { targetId } = await connection.send("Target.createTarget", { url: "about:blank" });
  const page = await CdpPage.attach(await connection.attach(targetId as string), {
    kind: "headless",
    policy: () => plainPolicy,
    networkAtAttach: false,
    clock: systemDriverClock,
  });
  return { peer, page, targetId: targetId as string };
};

describe("a page's frames", () => {
  it("attaches cross-site frames as child targets, each frame with its own isolated world, and answers a function keyed by frame in document order", async () => {
    const { peer, page, targetId } = await attached();
    peer.document("https://shop.example/", {
      frames: [
        { url: "https://shop.example/reviews" },
        { url: "https://pay.example/embed", crossSite: true },
      ],
    });
    peer.document("https://pay.example/embed", { frames: [{ url: "https://pay.example/card-field" }] });
    await page.navigate("https://shop.example/");
    peer.inPage("showsText", ({ frame, worldName }) => `${frame.url} in ${worldName}`);

    const answers = await page.callInEveryFrame(showsText, "anything");
    const pay = peer.target(targetId).children[0];
    const reviews = peer.target(targetId).frames[1];
    const cardField = pay?.frames[1];
    expect([...answers.keys()]).toEqual([targetId, reviews?.id, pay?.targetId, cardField?.id]);
    expect([...answers.values()].map((answer) => (answer.ok ? answer.value : answer.error))).toEqual([
      "https://shop.example/ in agent-harness",
      "https://shop.example/reviews in agent-harness",
      "https://pay.example/embed in agent-harness",
      "https://pay.example/card-field in agent-harness",
    ]);
    // The cross-site frame and the frame inside it are reached through the child target's session, each with its parent named.
    const payFrame = answers.get(pay?.targetId as string)?.frame;
    expect(payFrame).toMatchObject({ parentId: targetId, url: "https://pay.example/embed" });
    expect(payFrame?.sessionId).toEqual(expect.any(String));
    expect(answers.get(cardField?.id as string)?.frame).toMatchObject({ parentId: pay?.targetId, sessionId: payFrame?.sessionId });
    expect(answers.get(targetId)?.frame.sessionId).toBeUndefined();

    const worlds = peer.sentOf("Page.createIsolatedWorld").map(({ params, targetId: on }) => [params.frameId, on]);
    expect(worlds).toEqual([
      [targetId, targetId],
      [reviews?.id, targetId],
      [pay?.targetId, pay?.targetId],
      [cardField?.id, pay?.targetId],
    ]);
  });

  it("answers a frame's failure as that frame's entry, the others answered", async () => {
    const { peer, page, targetId } = await attached();
    peer.document("https://shop.example/", { frames: [{ url: "https://ads.example/slot", crossSite: true }] });
    await page.navigate("https://shop.example/");
    peer.inPage("showsText", ({ frame }) => {
      if (frame.url.startsWith("https://ads.example")) throw new Error("the ad's page threw");
      return true;
    });
    const answers = [...(await page.callInEveryFrame(showsText, "x")).values()];
    expect(answers.map((answer) => [answer.frame.url, answer.ok])).toEqual([
      ["https://shop.example/", true],
      ["https://ads.example/slot", false],
    ]);
    expect(answers[1]).toMatchObject({ error: "The page's script failed: Error: the ad's page threw" });
    expect(answers[0]?.frame.id).toBe(targetId);
  });

  it("drops a cross-site frame's frames when its target goes", async () => {
    const { peer, page, targetId } = await attached();
    peer.document("https://shop.example/", { frames: [{ url: "https://ads.example/slot", crossSite: true }] });
    await page.navigate("https://shop.example/");
    peer.target(targetId).children[0]?.close();
    await expect.poll(async () => [...(await page.callInEveryFrame(showsText, "x")).keys()], { timeout: 30_000 }).toEqual([targetId]);
  });

  it("makes a frame's world in the frame's own target, and a world the peer refuses is that frame's failure", async () => {
    const { peer, page } = await attached();
    await page.navigate("https://shop.example/");
    peer.answer("Page.createIsolatedWorld", () => {
      throw new CdpFailure("No frame for given id found");
    });
    const [answer] = [...(await page.callInEveryFrame(showsText, "x")).values()];
    expect(answer).toMatchObject({ ok: false, error: "Page.createIsolatedWorld: No frame for given id found" });
  });
});
