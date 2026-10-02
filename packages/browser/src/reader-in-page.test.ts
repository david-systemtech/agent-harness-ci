import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { fixtureHtml } from "../test/pages.js";
import type { InPageFunction } from "./driver/page.js";
import { installReader, pageChallenge, readPage } from "./reader-in-page.js";

/**
 * The reader's in-page half (browser spec, "`browser_read`"), run as the
 * driver runs it: from its source text, inside the page's realm, so the
 * vendored Readability, the Markdown conversion and challenge detection
 * reach for nothing but the page's DOM and their arguments.
 */

const realmOf = (html: string): Window & typeof globalThis => new JSDOM(html, { url: "https://blog.example/backups", runScripts: "outside-only" }).window;

/** Runs an in-page function in the page's realm from its source text, as `Runtime.callFunctionOn` does. */
const runIn = <A extends unknown[], R>(window: Window, fn: InPageFunction<A, R>, ...args: A): R =>
  (window as unknown as { eval(source: string): (...args: A) => R }).eval(`(${typeof fn === "function" ? fn.toString() : fn.declaration})`)(...args);

/** The page read as the driver reads it the first time in a document: the reader installed, then asked. */
const readIn = (window: Window, links = false) => {
  runIn(window, installReader);
  return runIn(window, readPage, { links });
};

/** The article the reader finds, failing the test where the page broke the reader. */
const articleIn = (window: Window, links = false): string | null => {
  const read = readIn(window, links);
  if (read === null || "failed" in read) throw new Error(`The reader answered ${JSON.stringify(read)}.`);
  return read.article;
};

describe("the reader in the page", () => {
  it("reads the page's article as Markdown with Readability on a copy of the document, leaving the live page as it was", () => {
    const window = realmOf(fixtureHtml("plain-article"));
    const before = window.document.documentElement.outerHTML;

    const article = articleIn(window);

    expect(article?.startsWith("# Keeping a homelab's backups honest\n\n")).toBe(true);
    expect(article).toContain("A backup nobody has restored is a hope, not a backup.");
    expect(article).toContain("## The drill");
    for (const boilerplate of ["Archive", "Your comment", "Written on a homelab"]) expect(article).not.toContain(boilerplate);
    expect(window.document.documentElement.outerHTML).toBe(before);
  });

  it("answers null in a world the reader was not installed in, and installing it again keeps the one the world holds", () => {
    const window = realmOf(fixtureHtml("plain-article"));
    expect(runIn(window, readPage, { links: false })).toBeNull();
    runIn(window, installReader);
    const installed = (window as unknown as { agentHarnessReader?: unknown }).agentHarnessReader;
    runIn(window, installReader);
    expect((window as unknown as { agentHarnessReader?: unknown }).agentHarnessReader).toBe(installed);
  });

  it("keeps link targets in the Markdown only when asked for them", () => {
    const html = `<!doctype html><title>Restore drills</title><body><article><h1>Restore drills</h1>${`<p>${"A restore proves a backup in a way no checksum can, so the drill is run every month. ".repeat(3)}See <a href="/runbook">the runbook</a> for the steps.</p>`.repeat(4)}</article></body>`;
    expect(articleIn(realmOf(html))).toContain("See the runbook for the steps.");
    expect(articleIn(realmOf(html), true)).toContain("See [the runbook](https://blog.example/runbook) for the steps.");
  });

  it("finds no article on a page Readability judges not readerable: an index of links and short lines", () => {
    const html = `<!doctype html><title>Releases</title><body><h1>Releases</h1><ul><li><a href="/v2">Version 2</a></li><li><a href="/v1">Version 1</a></li></ul><p>Each release lists its changes.</p></body>`;
    expect(readIn(realmOf(html))).toEqual({ article: null });
  });

  it("names the challenge the rendered page shows, and none on a page without one", () => {
    expect(runIn(realmOf(fixtureHtml("cloudflare-challenge")), pageChallenge)).toBe("cloudflare");
    expect(runIn(realmOf(fixtureHtml("duckduckgo-202")), pageChallenge)).toBe("javascript");
    expect(runIn(realmOf(fixtureHtml("plain-article")), pageChallenge)).toBeNull();
  });
});
