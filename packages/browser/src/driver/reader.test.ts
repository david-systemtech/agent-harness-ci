import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import type { PageReading } from "@agent-harness/contracts";
import { driven, type Driven } from "../../test/driven.js";
import { fixtureHtml } from "../../test/pages.js";
import type { InPageCall } from "../testing/index.js";
import type { AriaNodeJSON } from "../snapshot/vendor/aria-types.js";

/**
 * The reader through the page driver (browser spec, "`browser_read`"), over
 * the scripted CDP peer answering recorded documents: each in-page function
 * the driver sends the reader is run from the declaration it sent, in a
 * jsdom window of the document the frame holds, so what is tested is the
 * code a page runs. Readability judges a page, the article comes back as
 * Markdown in pages of 24,000 characters, an app's page as its snapshot's
 * text, and a challenge the page shows is named on the results.
 */

const BLOG = "https://blog.example/web";
const APP = "https://app.example/";

/** The in-page functions the reader and challenge detection send, by name. */
const READER_FUNCTIONS = ["installReader", "readPage", "pageChallenge"];

/**
 * Answers the reader's in-page functions in a jsdom window per document, by
 * running the declaration the driver sent there, as the page's isolated
 * world would: a world keeps what was installed in it until its document
 * goes.
 */
const recordedDocuments = (page: Driven, documents: Readonly<Record<string, string>>): void => {
  const windows = new Map<string, Window>();
  const windowOf = ({ frame }: InPageCall): Window => {
    const key = `${frame.url} ${frame.loaderId}`;
    const known = windows.get(key);
    if (known) return known;
    const html = documents[frame.url];
    if (html === undefined) throw new Error(`no recorded document at ${frame.url}`);
    const { window } = new JSDOM(html, { url: frame.url, runScripts: "outside-only" });
    windows.set(key, window);
    return window;
  };
  for (const name of READER_FUNCTIONS) {
    page.peer.inPage(name, (call) => (windowOf(call) as unknown as { eval(source: string): (...args: unknown[]) => unknown }).eval(`(${call.declaration})`)(...call.args));
  }
};

/**
 * A Wikipedia-length article, written for these tests: twelve sections of
 * eight long paragraphs, some 69,000 characters as Markdown, a navigation
 * bar and a footer around it that no reader keeps.
 */
const LONG_ARTICLE = (() => {
  const sentence = (section: number, paragraph: number): string =>
    `Section ${section}, paragraph ${paragraph}: the web grew from a proposal for sharing documents between physicists into the place where most people read, shop and talk, and each of its layers was built by people who disagreed about how open it should be.`;
  const sections = Array.from({ length: 12 }, (_, s) => {
    const paragraphs = Array.from({ length: 8 }, (_, p) => `<p>${sentence(s + 1, p + 1)} ${sentence(s + 1, p + 1).replace("the web grew", "it went on")} ${"Its standards were argued over in public. ".repeat(6)}</p>`);
    return `<h2>Part ${s + 1}</h2>${paragraphs.join("")}`;
  });
  return `<!doctype html><html><head><title>The World Wide Web</title></head><body>
    <nav><a href="/">Main page</a> <a href="/random">Random article</a></nav>
    <main><article><h1>The World Wide Web</h1>${sections.join("")}<p>The web's next decades will be shaped by the people who read it, which is the last sentence of this article.</p></article></main>
    <footer>Text is available under a licence for these tests.</footer></body></html>`;
})();

const LAST_SENTENCE = "The web's next decades will be shaped by the people who read it, which is the last sentence of this article.";

/** The driver on a page holding `html` at `url`. */
const at = async (url: string, html: string, title = "The World Wide Web"): Promise<Driven> => {
  const page = await driven();
  page.peer.document(url, { title });
  recordedDocuments(page, { [url]: html });
  expect(await page.perform("open", { url })).toMatchObject({ ok: true });
  return page;
};

const reading = (result: Awaited<ReturnType<Driven["perform"]>>): PageReading => {
  if (!result.ok) throw new Error(result.reason);
  return result.value as PageReading;
};

describe("browser_read through the driver", () => {
  it("returns a Wikipedia-length article as Markdown to its last sentence over successive offsets, 24,000 characters a page with the total and the next offset", async () => {
    const page = await at(BLOG, LONG_ARTICLE);

    const pages: PageReading[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const read = reading(await page.perform("read", { offset }));
      pages.push(read);
      offset = read.nextOffset;
    }

    expect(pages.length).toBeGreaterThanOrEqual(3);
    const [first] = pages;
    expect(first).toMatchObject({ url: BLOG, title: "The World Wide Web", source: "article", offset: 0, nextOffset: 24_000 });
    expect(first?.text.startsWith("# The World Wide Web\n\n## Part 1\n\nSection 1, paragraph 1: the web grew")).toBe(true);
    for (const read of pages) {
      expect(read.text.length).toBeLessThanOrEqual(24_000);
      expect(read.totalChars).toBe(first?.totalChars);
    }
    const whole = pages.map((read) => read.text).join("");
    expect(whole.length).toBe(first?.totalChars);
    expect(whole.endsWith(LAST_SENTENCE)).toBe(true);
    expect(whole).toContain("## Part 12");
    for (const boilerplate of ["Random article", "licence for these tests"]) expect(whole).not.toContain(boilerplate);
    expect(pages.at(-1)?.nextOffset).toBeNull();
  });

  it("keeps link targets only when the call asks for them", async () => {
    const html = LONG_ARTICLE.replace("<p>The web's next decades", `<p>See <a href="/history">its history</a>. The web's next decades`);
    const page = await at(BLOG, html);
    const last = async (links: boolean): Promise<string> => {
      const first = reading(await page.perform("read", { links }));
      return reading(await page.perform("read", { offset: first.totalChars - 200, links })).text;
    };
    expect(await last(false)).toContain(`See its history. ${LAST_SENTENCE}`);
    expect(await last(true)).toContain(`See [its history](https://blog.example/history). ${LAST_SENTENCE}`);
  });

  it("answers an offset past the end of the text with a sentence saying how long it is", async () => {
    const page = await at(BLOG, LONG_ARTICLE);
    const { totalChars } = reading(await page.perform("read", {}));
    expect(await page.perform("read", { offset: totalChars })).toEqual({
      ok: false,
      reason: `Offset ${totalChars} is past the end of the text, which is ${totalChars} characters long: ask for an offset from 0 to ${totalChars - 1}.`,
    });
  });

  it("returns the snapshot's text with every element where Readability judges the page not readerable, and says it is the snapshot's", async () => {
    const page = await at(APP, `<!doctype html><title>Lights</title><body><h1>Lights</h1><p>Living room</p><button>Turn off</button></body>`, "Lights");
    const nodes: AriaNodeJSON[] = [
      { role: "heading", name: "Lights", level: 1, ref: "e1" },
      { role: "paragraph", ref: "e2", text: "Living room" },
      { role: "button", name: "Turn off", ref: "e3", cursor: "pointer" },
    ];
    page.peer.inPage("snapshotFrame", () => ({ nodes, lastRef: 3 }));

    expect(await page.perform("read", {})).toEqual({
      ok: true,
      value: {
        url: APP,
        title: "Lights",
        source: "snapshot",
        text: `- heading "Lights" [level=1] [ref=e1]\n- paragraph [ref=e2]: Living room\n- button "Turn off" [ref=e3] [cursor=pointer]`,
        offset: 0,
        totalChars: 117,
        nextOffset: null,
      },
    });
  });

  it("answers a page whose element named after a DOM method breaks the reader with a sentence that says what to do instead (#696)", async () => {
    // This image makes `document.querySelectorAll` an element, and Readability calls it.
    const page = await at(BLOG, LONG_ARTICLE.replace("<main>", `<main><img name="querySelectorAll" src="/logo.png" alt="">`));
    expect(await page.perform("read", {})).toEqual({
      ok: false,
      reason: `${BLOG} could not be read. The reader could not read it: TypeError: doc.querySelectorAll is not a function. Take a snapshot to read its elements, or a screenshot to see what it shows.`,
    });
  });

  it("answers a sentence, never an empty reading, for a page with no article and no text", async () => {
    const page = await at(APP, `<!doctype html><title></title><body></body>`, "");
    page.peer.inPage("snapshotFrame", () => ({ nodes: [], lastRef: 0 }));
    expect(await page.perform("read", {})).toEqual({
      ok: false,
      reason: `${APP} has no text to read: the reader found no article on it, and its snapshot is empty. Take a screenshot to see what it shows.`,
    });
  });
});

describe("a challenge on the driver's results", () => {
  const CHALLENGE = "https://shop.example/";

  it("names the challenge a page shows, by kind, on the result of the load that reached it, on a snapshot and on a reading", async () => {
    const page = await at(BLOG, LONG_ARTICLE);
    page.peer.document(CHALLENGE, { title: "Just a moment..." });
    recordedDocuments(page, { [BLOG]: LONG_ARTICLE, [CHALLENGE]: fixtureHtml("cloudflare-challenge") });
    page.peer.inPage("snapshotFrame", () => ({ nodes: [{ role: "heading", name: "Just a moment...", level: 1, ref: "e1" }], lastRef: 1 }));

    expect(await page.perform("navigate", { url: CHALLENGE })).toEqual({ ok: true, value: { url: CHALLENGE, title: "Just a moment...", challenge: "cloudflare" } });
    expect(await page.perform("snapshot", {})).toMatchObject({ ok: true, value: { url: CHALLENGE, challenge: "cloudflare" } });
    expect(await page.perform("read", {})).toMatchObject({ ok: true, value: { url: CHALLENGE, source: "snapshot", challenge: "cloudflare" } });
  });

  it("names the challenge a click's load reached", async () => {
    const page = await at(BLOG, LONG_ARTICLE);
    page.peer.document(CHALLENGE, { title: "Just a moment..." });
    recordedDocuments(page, { [BLOG]: LONG_ARTICLE, [CHALLENGE]: fixtureHtml("datadome-403") });
    page.peer.inPage("locateElement", () => ({ kind: "found", x: 320, y: 240, editable: false }));
    page.peer.answer("Input.dispatchMouseEvent", (call) => {
      if (call.params.type === "mouseReleased") call.target?.navigate(CHALLENGE);
      return {};
    });
    expect(await page.perform("click", { target: { selector: "a.shop" } })).toEqual({ ok: true, value: { url: CHALLENGE, title: "Just a moment...", challenge: "datadome" } });
  });

  it("names the challenge on a reading of a challenge page with no text at all, rather than saying it has none", async () => {
    const page = await at(CHALLENGE, `<!doctype html><title></title><body><div class="cf-turnstile" data-sitekey="site-key-for-tests"></div></body>`, "");
    page.peer.inPage("snapshotFrame", () => ({ nodes: [], lastRef: 0 }));
    expect(await page.perform("read", {})).toEqual({
      ok: true,
      value: { url: CHALLENGE, title: "", source: "snapshot", text: "", offset: 0, totalChars: 0, nextOffset: null, challenge: "turnstile" },
    });
  });

  it("answers as it would without a finding when the page cannot be checked, and says so", async () => {
    const page = await at(BLOG, LONG_ARTICLE);
    page.peer.inPage("pageChallenge", () => {
      throw new Error("the check met a page it could not read");
    });
    expect(await page.perform("open", {})).toEqual({
      ok: true,
      value: { url: BLOG, title: "The World Wide Web" },
      notice: "The browser could not check the page for a challenge: The page's script failed: Error: the check met a page it could not read.",
    });
  });

  it("reads a page whose element named after a DOM method breaks the check, and says in a sentence, without the script's stack, that it could not check it (#696)", async () => {
    // A document's named elements override its members: this image makes `document.querySelector` an element.
    const page = await at(BLOG, LONG_ARTICLE.replace("<main>", `<main><img name="querySelector" src="/logo.png" alt="">`));
    expect(await page.perform("read", {})).toMatchObject({
      ok: true,
      value: { url: BLOG, source: "article" },
      notice: "The browser could not check the page for a challenge: The page's script failed: TypeError: document.querySelector is not a function.",
    });
  });

  it("carries no finding on a page with no challenge", async () => {
    const page = await at(BLOG, LONG_ARTICLE);
    page.peer.inPage("snapshotFrame", () => ({ nodes: [{ role: "heading", name: "The World Wide Web", level: 1, ref: "e1" }], lastRef: 1 }));
    for (const result of [await page.perform("open", {}), await page.perform("navigate", { url: BLOG }), await page.perform("snapshot", {}), await page.perform("read", {})]) {
      expect(result.ok).toBe(true);
      expect(result.ok && result.value).not.toHaveProperty("challenge");
    }
  });
});
