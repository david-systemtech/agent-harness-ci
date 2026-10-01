import { describe, expect, it } from "vitest";
import type { InPageCall } from "../testing/index.js";
import type { AriaNodeJSON } from "../snapshot/vendor/aria-types.js";
import type { FrameSnapshotOptions } from "../snapshot/world.js";
import { driven, manualClock, type Driven } from "../../test/driven.js";

/**
 * The snapshot and refs through the page driver, over the scripted CDP peer
 * answering recorded per-frame results (browser spec, "The tools"): every
 * frame read in its own isolated world, stitched under the iframe that holds
 * it, and the refs it gave acted on in their frames.
 */

type Recorded = Readonly<Record<string, readonly AriaNodeJSON[]>>;

/** Each frame's tree as the in-page snapshot answers it, by the frame's address, its refs given the prefix the driver asked for. */
const recorded =
  (frames: Recorded) =>
  ({ frame, args }: InPageCall): unknown => {
    const { prefix } = args[0] as FrameSnapshotOptions;
    let lastRef = 0;
    const prefixed = (node: AriaNodeJSON | string): AriaNodeJSON | string => {
      if (typeof node === "string") return node;
      if (node.ref !== undefined) lastRef = Math.max(lastRef, Number(node.ref.slice(1)));
      return { ...node, ...(node.ref !== undefined && { ref: `${prefix}${node.ref}` }), ...(node.children && { children: node.children.map(prefixed) }) };
    };
    const nodes = frames[frame.url];
    if (nodes === undefined) throw new Error(`no recorded snapshot of ${frame.url}`);
    return { nodes: nodes.map(prefixed), lastRef };
  };

const SHOP = "https://shop.example/";
const REVIEWS = "https://shop.example/reviews";
const PAY = "https://pay.example/embed";
const CARD = "https://pay.example/card-field";

/** A checkout with a same-site frame, and a cross-site frame with a frame of its own. */
const CHECKOUT: Recorded = {
  [SHOP]: [
    { role: "heading", name: "Checkout", level: 1, ref: "e1" },
    { role: "iframe", ref: "e2", frame: 0 },
    { role: "iframe", ref: "e3", frame: 1 },
  ],
  [REVIEWS]: [{ role: "paragraph", ref: "e1", text: "Five stars from every buyer." }],
  [PAY]: [
    { role: "paragraph", ref: "e1", text: "Card accepted." },
    { role: "iframe", ref: "e2", frame: 0 },
  ],
  [CARD]: [{ role: "textbox", name: "Card number", ref: "e1", field: { type: "text", autocomplete: "cc-number" }, text: "[redacted: a payment card detail]" }],
};

/** Each frame's owner iframe's place among its parent's frame owners. */
const OWNER_KEYS: Readonly<Record<string, number>> = { [REVIEWS]: 0, [PAY]: 1, [CARD]: 0 };

/** The driver on the checkout, the frames' snapshots and owners answered as recorded. */
const atCheckout = async (frames: Recorded = CHECKOUT): Promise<Driven> => {
  const page = await driven();
  page.peer.document(SHOP, { title: "Checkout", frames: [{ url: REVIEWS }, { url: PAY, crossSite: true }] });
  page.peer.document(PAY, { frames: [{ url: CARD }] });
  page.peer.inPage("snapshotFrame", recorded(frames));
  page.peer.inPage("frameOwnerKey", ({ owner }) => (owner === undefined ? null : (OWNER_KEYS[owner.url] ?? null)));
  expect(await page.perform("open", { url: SHOP })).toMatchObject({ ok: true });
  return page;
};

const STITCHED = `- heading "Checkout" [level=1] [ref=e1]
- iframe [ref=e2]:
  - paragraph [ref=f1e1]: Five stars from every buyer.
- iframe [ref=e3]:
  - paragraph [ref=f2e1]: Card accepted.
  - iframe [ref=f2e2]:
    - textbox "Card number" [ref=f3e1]: "[redacted: a payment card detail]"`;

const stale = (ref: string): string =>
  `No element on the page has the ref ${ref} now: it is from an older snapshot, or its element has left the page. Take a new snapshot and act on the refs it gives.`;

const mouse = (peer: Driven["peer"]) => peer.sentOf("Input.dispatchMouseEvent").map(({ params }) => [params.type, params.x, params.y]);

describe("the snapshot", () => {
  it("reads every frame in its own isolated world and stitches them into one tree in document order, a child frame's refs carrying its prefix", async () => {
    const { peer, perform } = await atCheckout();
    expect(await perform("snapshot", { filter: "all" })).toEqual({
      ok: true,
      value: { url: SHOP, title: "Checkout", text: STITCHED, totalChars: STITCHED.length, truncated: false },
    });
    const calls = peer.sentOf("Runtime.callFunctionOn").filter(({ params }) => String(params.functionDeclaration).startsWith("function snapshotFrame("));
    expect(calls.map(({ params }) => params.arguments)).toEqual([
      [{ value: { prefix: "", firstRef: 1 } }],
      [{ value: { prefix: "f1", firstRef: 1 } }],
      [{ value: { prefix: "f2", firstRef: 1 } }],
      [{ value: { prefix: "f3", firstRef: 1 } }],
    ]);
    // Each frame's owner is asked for in its parent's world, through the parent's own target, and let go of after.
    const pay = peer.target(peer.sentOf("Page.navigate")[0]?.targetId as string).children[0];
    expect(peer.sentOf("DOM.getFrameOwner").map(({ targetId }) => targetId === pay?.targetId)).toEqual([false, false, true]);
    expect(peer.sentOf("Runtime.releaseObject")).toHaveLength(3);
  });

  it("keeps the elements that can be acted on by default, under the frames that hold them", async () => {
    const { perform } = await atCheckout();
    const interactive = `- iframe [ref=e3]:
  - iframe [ref=f2e2]:
    - textbox "Card number" [ref=f3e1]: "[redacted: a payment card detail]"`;
    expect(await perform("snapshot", {})).toMatchObject({ ok: true, value: { text: interactive, truncated: false } });
  });

  it("cuts the stitched text at a line boundary within maxChars and states its full length", async () => {
    const { perform } = await atCheckout();
    const cut = STITCHED.slice(0, STITCHED.indexOf("\n- iframe [ref=e3]"));
    expect(await perform("snapshot", { filter: "all", maxChars: cut.length + 5 })).toMatchObject({
      ok: true,
      value: { text: cut, totalChars: STITCHED.length, truncated: true },
    });
  });

  it("focuses on a ref in a child frame, and refuses a ref the page no longer has", async () => {
    const { perform } = await atCheckout();
    expect(await perform("snapshot", { filter: "all", ref: "f2e2" })).toMatchObject({
      ok: true,
      value: { text: `- iframe [ref=f2e2]:\n  - textbox "Card number" [ref=f3e1]: "[redacted: a payment card detail]"` },
    });
    expect(await perform("snapshot", { ref: "f2e9" })).toEqual({
      ok: false,
      reason: "No element on the page has the ref f2e9 now: it is from an older snapshot, or its element has left the page. Take a new snapshot without ref, and focus on a ref it gives.",
    });
  });

  it("leaves out a frame that could not be read and says which, and refuses when the page itself could not be read", async () => {
    const { peer, perform } = await atCheckout({ ...CHECKOUT, [REVIEWS]: undefined } as unknown as Recorded);
    expect(await perform("snapshot", { filter: "all" })).toMatchObject({
      ok: true,
      value: { text: STITCHED.replace("  - paragraph [ref=f1e1]: Five stars from every buyer.\n", "").replace("- iframe [ref=e2]:", "- iframe [ref=e2]") },
      notice: `A frame of the page could not be read (${REVIEWS}): The page's script failed: Error: no recorded snapshot of ${REVIEWS}.`,
    });
    peer.inPage("snapshotFrame", () => {
      throw new Error("the page's document is gone");
    });
    expect(await perform("snapshot", {})).toEqual({ ok: false, reason: "The browser could not read the page: The page's script failed: Error: the page's document is gone." });
  });

  it("says when nothing on the page can be acted on, pointing at filter all", async () => {
    const { perform } = await atCheckout({ ...CHECKOUT, [CARD]: [{ role: "paragraph", ref: "e1", text: "Loading." }] });
    expect(await perform("snapshot", {})).toEqual({
      ok: true,
      value: { url: SHOP, title: "Checkout", text: "", totalChars: 0, truncated: false },
      notice: "Nothing on the page can be acted on. Take a snapshot with filter all to read every element.",
    });
  });

  it("answers an action with the snapshot it asked for", async () => {
    const { perform } = await atCheckout();
    expect(await perform("open", { snapshot: { filter: "all", maxChars: 50 } })).toEqual({
      ok: true,
      value: { url: SHOP, title: "Checkout", snapshot: { text: `- heading "Checkout" [level=1] [ref=e1]`, totalChars: STITCHED.length, truncated: true } },
    });
  });

  it("sends the vendored snapshot to a world once, when the world answers it has none, and asks it again", async () => {
    const page = await driven();
    page.peer.document(SHOP, { title: "Checkout" });
    const installedIn = new Set<string>();
    page.peer.inPage("installSnapshot", ({ frame }) => void installedIn.add(frame.loaderId));
    const record = recorded({ [SHOP]: [{ role: "button", name: "Pay", ref: "e1" }] });
    page.peer.inPage("snapshotFrame", (call) => (installedIn.has(call.frame.loaderId) ? record(call) : null));
    await page.perform("open", { url: SHOP });
    expect(await page.perform("snapshot", {})).toMatchObject({ ok: true, value: { text: `- button "Pay" [ref=e1]` } });
    expect(await page.perform("snapshot", {})).toMatchObject({ ok: true });
    const sent = page.peer.sentOf("Runtime.callFunctionOn").map(({ params }) => /^function (\w+)/.exec(String(params.functionDeclaration))?.[1]);
    expect(sent).toEqual(["snapshotFrame", "installSnapshot", "snapshotFrame", "snapshotFrame"]);
  });

  it("asks each frame's next snapshot to number past the refs it gave, so no ref an older snapshot gave names another element", async () => {
    const { peer, perform } = await atCheckout();
    await perform("snapshot", {});
    peer.document("https://shop.example/thanks", { title: "Thank you" });
    peer.inPage("snapshotFrame", recorded({ "https://shop.example/thanks": [{ role: "link", name: "Shop again", ref: "e1" }] }));
    await perform("navigate", { url: "https://shop.example/thanks" });
    expect(await perform("snapshot", {})).toMatchObject({ ok: true });
    expect(peer.sentOf("Runtime.callFunctionOn").at(-1)?.params.arguments).toEqual([{ value: { prefix: "", firstRef: 4 } }]);
  });
});

describe("acting by ref", () => {
  it("clicks an element by its ref at its centre, a child frame's element offset by where its frames sit on the page", async () => {
    const { peer, perform } = await atCheckout();
    await perform("snapshot", {});
    peer.inPage("locateElement", () => ({ kind: "found", x: 30, y: 10, editable: true }));
    peer.inPage("frameOwnerOrigin", ({ owner }) => (owner?.url === PAY ? { x: 100, y: 300 } : { x: 8, y: 40 }));
    expect(await perform("click", { target: { ref: "e1" } })).toMatchObject({ ok: true });
    expect(await perform("click", { target: { ref: "f3e1" } })).toMatchObject({ ok: true });
    expect(mouse(peer).filter(([type]) => type === "mousePressed")).toEqual([
      ["mousePressed", 30, 10],
      ["mousePressed", 138, 350],
    ]);
    const located = peer.sentOf("Runtime.callFunctionOn").filter(({ params }) => String(params.functionDeclaration).startsWith("function locateElement("));
    expect(located.map(({ params }) => params.arguments)).toEqual([[{ value: { ref: "e1" } }], [{ value: { ref: "f3e1" } }]]);
  });

  it("types into a field by its ref in its own frame", async () => {
    const { peer, perform } = await atCheckout();
    await perform("snapshot", {});
    peer.inPage("locateElement", () => ({ kind: "found", x: 30, y: 10, editable: true }));
    peer.inPage("frameOwnerOrigin", () => ({ x: 0, y: 0 }));
    let selectedIn: string | undefined;
    peer.inPage("selectFieldContents", ({ frame, args }) => {
      selectedIn = `${frame.url} ${JSON.stringify(args[0])}`;
      return "selected";
    });
    expect(await perform("type", { target: { ref: "f3e1" }, text: "0000 1111 2222 3333" })).toMatchObject({ ok: true });
    expect(selectedIn).toBe(`${CARD} {"ref":"f3e1"}`);
    expect(peer.sentOf("Input.insertText")[0]?.params).toEqual({ text: "0000 1111 2222 3333" });
  });

  it("refuses a ref no snapshot of this page gave, and one whose element has left the page, telling the model to take a new snapshot", async () => {
    const { peer, perform } = await atCheckout();
    expect(await perform("click", { target: { ref: "e1" } })).toEqual({ ok: false, reason: stale("e1") });
    await perform("snapshot", {});
    expect(await perform("type", { target: { ref: "f9e1" }, text: "x" })).toEqual({ ok: false, reason: stale("f9e1") });
    expect(peer.sentOf("Runtime.callFunctionOn").some(({ params }) => String(params.functionDeclaration).startsWith("function locateElement("))).toBe(false);
    peer.inPage("locateElement", () => ({ kind: "stale" }));
    expect(await perform("click", { target: { ref: "f1e1" } })).toEqual({ ok: false, reason: stale("f1e1") });
    expect(mouse(peer)).toEqual([]);
  });

  it("refuses a ref whose frame, or a frame holding it, leaves the page while the click is placed, rather than clicking where the frame was", async () => {
    const { peer, perform } = await atCheckout();
    await perform("snapshot", {});
    const sessionId = peer.sentOf("Page.enable")[0]?.sessionId;
    const leaves = (frameId: string) => peer.emit("Page.frameDetached", { frameId, reason: "remove" }, sessionId);
    peer.inPage("locateElement", ({ frame }) => {
      if (frame.url === REVIEWS) leaves(frame.id);
      return { kind: "found", x: 30, y: 10, editable: false };
    });
    peer.inPage("frameOwnerOrigin", ({ frame, owner }) => {
      if (owner?.url === CARD) leaves(frame.id);
      return { x: 8, y: 40 };
    });
    expect(await perform("click", { target: { ref: "f1e1" } })).toEqual({ ok: false, reason: stale("f1e1") });
    expect(await perform("click", { target: { ref: "f3e1" } })).toEqual({ ok: false, reason: stale("f3e1") });
    expect(mouse(peer)).toEqual([]);
  });

  it("scrolls to an element by its ref, and refuses a ref whose element has left the page", async () => {
    const { peer, perform } = await atCheckout();
    await perform("snapshot", {});
    let scrolled: unknown;
    peer.inPage("scrollToElement", ({ frame, args }) => {
      scrolled = [frame.url, args[0]];
      return args[0] === "f1e1" ? "scrolled" : "stale";
    });
    expect(await perform("scroll", { to: { ref: "f1e1" } })).toEqual({ ok: true, value: { url: SHOP, title: "Checkout" } });
    expect(scrolled).toEqual([REVIEWS, "f1e1"]);
    expect(await perform("scroll", { to: { ref: "e1" } })).toEqual({ ok: false, reason: stale("e1") });
  });

  it("waits for the element a ref names to show, looking again until it does, and refuses at once a ref whose element has left the page", async () => {
    const clock = manualClock();
    const page = await driven({ clock });
    page.peer.document(SHOP, { title: "Checkout" });
    page.peer.inPage("snapshotFrame", recorded({ [SHOP]: [{ role: "button", name: "Pay", ref: "e1" }] }));
    await page.perform("open", { url: SHOP });
    await page.perform("snapshot", {});
    let shows = "hidden";
    page.peer.inPage("elementShows", ({ args }) => (args[0] === "e1" ? shows : "stale"));
    const answer = page.perform("waitFor", { until: { ref: "e1" } });
    await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
    shows = "shown";
    clock.advance(250);
    expect(await answer).toEqual({ ok: true, value: { url: SHOP, title: "Checkout" } });
    expect(await page.perform("waitFor", { until: { ref: "e7" } })).toEqual({ ok: false, reason: stale("e7") });

    shows = "hidden";
    const never = page.perform("waitFor", { until: { ref: "e1", timeoutMs: 1_000 } });
    for (let waited = 0; waited < 1_000; waited += 250) {
      await expect.poll(() => clock.pending(), { timeout: 30_000 }).toBe(1);
      clock.advance(250);
    }
    expect(await never).toEqual({ ok: false, reason: "The element e1 did not show on the page within 1 second." });
  });
});
