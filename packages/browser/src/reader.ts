import type { ChallengeKind } from "@agent-harness/contracts";
import { detectChallenge } from "./challenge.js";
import { articleMarkdown, type ReaderArticle } from "./markdown.js";
import { isShell } from "./shell.js";
import { mozillaReaderable, type IsProbablyReaderable } from "./vendor/readability-readerable.js";
import { mozillaReadability, type ReadabilityConstructor } from "./vendor/readability.js";

/**
 * The reader (browser spec, "`browser_read`" and "`web_read`"): Mozilla
 * Readability 0.6.0 (Apache-2.0, vendored with its notice in ./vendor/) on a
 * copy of a document, so the page itself is left as it was, and its article
 * handed to the Markdown conversion. `web_read` runs it on a fetched page in
 * jsdom, and `browser_read` in the rendered page's isolated world, where it
 * runs from its source text (./reader-in-page.ts).
 */

/** The reader, made afresh wherever it runs from Readability and its readerable check: on jsdom, or in a page's isolated world. */
export function readerModule(Readability: ReadabilityConstructor, isProbablyReaderable: IsProbablyReaderable) {
  /**
   * The article Readability finds in `document`, or null where it judges the
   * page not readerable (an app, a result page, an index) or finds none. It
   * reads a copy: Readability rewrites the document it is given.
   */
  const readArticle = (document: Document): ReaderArticle | null => {
    if (!isProbablyReaderable(document)) return null;
    // Classes kept, so a code block's language (`language-sh`) reaches the Markdown.
    const article = new Readability(document.cloneNode(true) as Document, { keepClasses: true, serializer: (node: Node) => node }).parse();
    if (article === null || article.content === null || article.content === undefined) return null;
    return { title: article.title ?? null, content: article.content };
  };

  return { readArticle };
}

export const { readArticle } = readerModule(mozillaReadability(), mozillaReaderable());

/**
 * A fetched page as `web_read` reads it: the challenge it shows, named; a
 * shell, which reading without a browser gives next to nothing of; its
 * article as Markdown; or, where Readability finds none, the document's own
 * text as Markdown: its body, what no reader sees left out.
 */
export type FetchedPage =
  | { readonly kind: "challenge"; readonly challenge: ChallengeKind }
  | { readonly kind: "shell" }
  | { readonly kind: "article" | "document"; readonly markdown: string };

/**
 * Reads a fetched page in that order: a challenge first, since a vendor's
 * check can carry enough text not to look like a shell; then the shell
 * rule; then the reader; then the whole document. A page with no text at
 * all reads as an empty document, which the caller answers with a sentence.
 */
export const readFetchedPage = (document: Document): FetchedPage => {
  const challenge = detectChallenge(document);
  if (challenge !== null) return { kind: "challenge", challenge };
  if (isShell(document)) return { kind: "shell" };
  const article = readArticle(document);
  if (article !== null) return { kind: "article", markdown: articleMarkdown(article) };
  return { kind: "document", markdown: articleMarkdown({ content: document.body ?? document.documentElement }) };
};
