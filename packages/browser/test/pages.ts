import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * The fixture pages: #292's measured pages and the others each names, as
 * served and then trimmed, their values faked. Parsed in jsdom the way a
 * fetched page is: no script runs, so what a page's script would render is
 * not there.
 */
export const FIXTURES = [
  "home-assistant-shell",
  "excalidraw-shell",
  "reddit-js-challenge",
  "datadome-403",
  "perimeterx-403",
  "duckduckgo-202",
  "cloudflare-challenge",
  "anubis-challenge",
  "plain-article",
] as const;
export type Fixture = (typeof FIXTURES)[number];

/** HTML parsed as a document, at an address of its own. */
export const pageOf = (html: string): Document => new JSDOM(html, { url: "https://example.com/page" }).window.document;

/** A fixture page, parsed. */
export const fixturePage = (name: Fixture): Document => pageOf(readFileSync(new URL(`./fixtures/${name}.html`, import.meta.url), "utf8"));
