import { describe, expect, it } from "vitest";
import { fixturePage, pageOf } from "../test/pages.js";
import { SHELL_TEXT_CHARS, isShell } from "./index.js";

/** A page whose body is `body`. */
const page = (body: string): Document => pageOf(`<!doctype html><html><head><title>A page</title><script src="/app.js"></script></head><body>${body}</body></html>`);

/** `n` characters of prose. */
const prose = (n: number): string => "Words of a page. ".repeat(Math.ceil(n / 17)).slice(0, n);

describe("the shell rule web_read uses", () => {
  it("finds the Lit shell a shell: Home Assistant's served page, its app's element empty until its script runs", () => {
    expect(isShell(fixturePage("home-assistant-shell"))).toBe(true);
  });

  it("finds an empty app shell a shell: Excalidraw's served page, an empty root and a noscript line", () => {
    expect(isShell(fixturePage("excalidraw-shell"))).toBe(true);
    expect(isShell(page(`<noscript>Sorry, Element requires JavaScript to be enabled.</noscript><div id="matrixchat"></div>`))).toBe(true);
  });

  it("finds a short page saying to enable JavaScript a shell, with no noscript element", () => {
    expect(isShell(page(`<p>Please enable JS and disable any ad blocker</p>`))).toBe(true);
    expect(isShell(page(`<div id="app"><p>This site requires JavaScript.</p></div>`))).toBe(true);
  });

  it("finds a short real page no shell: no noscript element, no enable-JavaScript line, no empty app element", () => {
    const example = `<div><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission. Avoid use in operations.</p><p><a href="https://iana.org/domains/example">Learn more</a></p></div>`;
    expect(isShell(page(example))).toBe(false);
    expect(isShell(page(`<h1>Not found</h1><p>No page lives at this address.</p><my-footer>Written by hand.</my-footer>`))).toBe(false);
  });

  it("finds a page of 200 characters or more no shell, whatever else it holds", () => {
    expect(SHELL_TEXT_CHARS).toBe(200);
    expect(isShell(page(`<noscript>Enable JavaScript.</noscript><p>${prose(199)}</p>`))).toBe(true);
    expect(isShell(page(`<noscript>Enable JavaScript.</noscript><p>${prose(200)}</p>`))).toBe(false);
    expect(isShell(fixturePage("plain-article"))).toBe(false);
  });

  it("measures the page's body on a page whose element named body takes the document's own member's place (#1052)", () => {
    const named = page(`<img name="body" src="/logo.png" alt=""><noscript>Enable JavaScript.</noscript><p>${prose(200)}</p>`);
    expect(named.body.localName).toBe("img");
    expect(isShell(named)).toBe(false);
  });

  it("counts the text a reader sees: not scripts, styles, noscript fallbacks or hidden elements", () => {
    const unseen = `<style>${prose(400)}</style><script>var x = "${prose(400)}";</script><div hidden>${prose(400)}</div><noscript>${prose(400)}</noscript>`;
    expect(isShell(page(`${unseen}<div id="root"></div>`))).toBe(true);
  });
});
