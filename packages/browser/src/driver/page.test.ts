import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { plainPolicy } from "../../test/driven.js";
import type { TsxInPage } from "../../test/tsx-in-page.js";
import { cdpConnection } from "../cdp/connection.js";
import { webSocketTransport } from "../cdp/web-socket.js";
import { CdpFailure, scriptedCdpPeer, type InPageCall } from "../testing/index.js";
import { showsText } from "./in-page.js";
import { CdpPage, systemDriverClock } from "./page.js";

/**
 * A page's frames as the driver stitches them (browser spec, "One page
 * driver for three browsers"): its own frames and its cross-site frames'
 * child targets, each frame with its own isolated world, and an in-page
 * function's answers keyed by frame, as the snapshot and the reader read
 * every frame (#544, #545); and an in-page function sent so that it runs in
 * the page whatever transform loaded the package (#966).
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

/** Spawning tsx on a loaded runner: a cap for a hang, not a budget. */
const TSX_MS = 60_000;

describe("an in-page function loaded through tsx", () => {
  // The package as a development run loads it, from source through tsx, whose transform names functions with a helper the page lacks.
  let tsx: TsxInPage;
  beforeAll(async () => {
    const script = fileURLToPath(new URL("../../test/tsx-in-page.ts", import.meta.url));
    const loader = createRequire(import.meta.url).resolve("tsx");
    const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=@agent-harness/source", "--import", loader, script]);
    tsx = JSON.parse(stdout) as TsxInPage;
  }, TSX_MS);

  /** A function made from tsx's source text of it, whose own source text the driver sends. */
  const fromTsx = <F>(name: string): F => runInNewContext(`(${tsx.functions[name]})`) as F;

  const ARTICLE = `<!doctype html><html><head><title>Example Domain</title></head><body><nav><a href="/">Home</a></nav><article><h1>Example Domain</h1>${`<p>${"This domain is for use in documentation examples without needing permission. ".repeat(4)}</p>`.repeat(4)}</article><iframe src="https://blog.example/comments" style="padding-left: 3px; padding-top: 4px"></iframe></body></html>`;

  /** The page at https://blog.example/web with its comments frame, each frame's in-page calls run from the declaration sent, in a jsdom window of its document, which has no `__name`. */
  const blogPage = async () => {
    const { peer, page, targetId } = await attached();
    peer.document("https://blog.example/web", { title: "Example Domain", frames: [{ url: "https://blog.example/comments" }] });
    await page.navigate("https://blog.example/web");
    const windows: Record<string, Window & typeof globalThis> = {
      "https://blog.example/web": new JSDOM(ARTICLE, { url: "https://blog.example/web", runScripts: "outside-only" }).window,
      "https://blog.example/comments": new JSDOM(`<button>Save</button>`, { url: "https://blog.example/comments", runScripts: "outside-only" }).window,
    };
    const comments = windows["https://blog.example/comments"] as Window & typeof globalThis;
    // jsdom lays nothing out: every element of the comments gets a box, so the snapshot sees it.
    comments.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) });
    // jsdom computes no pseudo-element's style, and says so on every call: an element's own style has no content either.
    const computed = comments.getComputedStyle.bind(comments);
    comments.getComputedStyle = (element: Element) => computed(element);
    const answer = ({ frame, declaration, args, owner }: InPageCall): unknown => {
      const window = windows[frame.url] as Window & typeof globalThis;
      const fn = (window as unknown as { eval(source: string): (this: unknown, ...args: unknown[]) => unknown }).eval(`(${declaration})`);
      return owner === undefined ? fn(...args) : fn.call(window.document.querySelector("iframe"));
    };
    for (const name of ["installSnapshot", "snapshotFrame", "installReader", "readPage", "pageChallenge", "showsText", "readStorage", "frameOwnerOrigin"]) peer.inPage(name, answer);
    const commentsFrame = page.frame(peer.target(targetId).frames[1]?.id as string);
    if (commentsFrame === undefined) throw new Error("the comments frame is not on the page");
    return { page, comments: commentsFrame };
  };

  it("is named by tsx with a helper of its own, which the page does not have", () => {
    for (const declaration of ["installSnapshot", "installReader", "pageChallenge"]) expect(tsx.declarations[declaration], declaration).toContain("__name(");
    for (const fn of ["showsText", "readStorage"]) expect(tsx.functions[fn], fn).toContain("__name(");
  });

  it("runs the snapshot, the reader and challenge detection, composed from tsx's source texts, in a page", async () => {
    const { page, comments } = await blogPage();
    await page.callInFrame(comments, { declaration: tsx.declarations["installSnapshot"] as string });
    const snapshot = await page.callInFrame(comments, fromTsx<(options: object) => unknown>("snapshotFrame"), { prefix: "f1", firstRef: 1 });
    expect(snapshot).toEqual({ nodes: [{ role: "button", name: "Save", ref: "f1e2" }], lastRef: 2 });

    await page.callInFrame(page.mainFrame(), { declaration: tsx.declarations["installReader"] as string });
    const read = await page.callInFrame(page.mainFrame(), fromTsx<(options: object) => unknown>("readPage"), { links: false });
    expect(read).toEqual({ article: expect.stringContaining("This domain is for use in documentation examples without needing permission.") });
    expect(await page.callInFrame(page.mainFrame(), { declaration: tsx.declarations["pageChallenge"] as string })).toBeNull();
  });

  it("runs the driver's own functions from tsx's source texts in a page, on a frame's owner element too", async () => {
    const { page, comments } = await blogPage();
    expect(await page.callInFrame(page.mainFrame(), fromTsx<(text: string) => boolean>("showsText"), "documentation examples")).toBe(true);
    expect(await page.callInFrame(page.mainFrame(), fromTsx<() => unknown>("readStorage"))).toEqual({ origin: "https://blog.example", local: {}, session: {} });
    expect(await page.callOnFrameOwner(comments, fromTsx<(this: Element) => unknown>("frameOwnerOrigin"))).toEqual({ x: 3, y: 4 });
  });
});
