import { describe, expect, it } from "vitest";
import { fixturePage, pageOf } from "../test/pages.js";
import { readFetchedPage } from "./index.js";

/**
 * A fetched page read as `web_read` reads it (browser spec, "`web_read`"):
 * a challenge named, a shell said, an article through Readability as
 * Markdown, and a page Readability does not judge readerable as the
 * document's own text. Parsed in jsdom as a fetched page is, no script run.
 */

/** A page with no article: a list of links and a short line, what a result page or an index looks like. */
const INDEX = `<!doctype html><html><head><title>Releases</title></head><body>
  <nav><a href="/">Home</a></nav>
  <h1>Releases</h1>
  <ul><li><a href="/v2">Version 2</a>, the current one</li><li><a href="/v1">Version 1</a>, kept for old machines</li></ul>
  <p>Each release lists its changes on its own page.</p>
  <script>window.tracked = true;</script>
</body></html>`;

describe("a fetched page as web_read reads it", () => {
  it("reads an article through Readability as Markdown, its title first, the page's navigation, comment form and footer left out", () => {
    const read = readFetchedPage(fixturePage("plain-article"));
    expect(read.kind).toBe("article");
    if (read.kind !== "article") return;
    expect(read.markdown.startsWith("# Keeping a homelab's backups honest\n\n")).toBe(true);
    expect(read.markdown).toContain("A backup nobody has restored is a hope, not a backup.");
    expect(read.markdown).toContain("## The drill");
    expect(read.markdown).toContain("1. Choose a snapshot older than a week, so the drill also proves retention works.");
    expect(read.markdown).toContain("| Snapshot age | Retention is part of the promise. |");
    expect(read.markdown).toContain("```sh\nrestic restore latest --target /tmp/drill --include /srv/photos\n```");
    expect(read.markdown).toContain("a restore that got slower is the first sign of a disk on its way out.");
    for (const boilerplate of ["Archive", "Your comment", "Written on a homelab"]) expect(read.markdown).not.toContain(boilerplate);
  });

  it("leaves the page it read as it was: Readability runs on a copy", () => {
    const page = fixturePage("plain-article");
    const before = page.documentElement.outerHTML;
    readFetchedPage(page);
    expect(page.documentElement.outerHTML).toBe(before);
  });

  it("reads a page Readability does not judge readerable as the document's text, in Markdown, scripts left out", () => {
    const read = readFetchedPage(pageOf(INDEX));
    expect(read).toEqual({
      kind: "document",
      markdown: [
        "Home",
        "# Releases",
        "- Version 2, the current one\n- Version 1, kept for old machines",
        "Each release lists its changes on its own page.",
      ].join("\n\n"),
    });
  });

  it("names a challenge the page shows, before anything else it could be read as", () => {
    expect(readFetchedPage(fixturePage("cloudflare-challenge"))).toEqual({ kind: "challenge", challenge: "cloudflare" });
    expect(readFetchedPage(fixturePage("datadome-403"))).toEqual({ kind: "challenge", challenge: "datadome" });
    expect(readFetchedPage(fixturePage("duckduckgo-202"))).toEqual({ kind: "challenge", challenge: "javascript" });
    expect(readFetchedPage(fixturePage("reddit-js-challenge"))).toEqual({ kind: "challenge", challenge: "javascript" });
  });

  it("says a shell is one rather than reading its next to nothing", () => {
    expect(readFetchedPage(fixturePage("home-assistant-shell"))).toEqual({ kind: "shell" });
    expect(readFetchedPage(fixturePage("excalidraw-shell"))).toEqual({ kind: "shell" });
  });

  it("reads a page with no text at all as an empty document, which the caller answers with a sentence", () => {
    expect(readFetchedPage(pageOf("<!doctype html><html><head><title></title></head><body></body></html>"))).toEqual({ kind: "document", markdown: "" });
  });
});
