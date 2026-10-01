import type { ChallengeKind } from "@agent-harness/contracts";
import { challengeModule } from "./challenge.js";
import type { InPageSource } from "./driver/page.js";
import { markdownModule } from "./markdown.js";
import { pageTextModule } from "./page-text.js";
import { readerModule } from "./reader.js";
import { mozillaReaderable } from "./vendor/readability-readerable.js";
import { mozillaReadability } from "./vendor/readability.js";

/**
 * The reader's in-page functions (browser spec, "`browser_read`" and
 * "Model-boundary hygiene"): what the driver runs in the top frame's
 * isolated world, where the page's own scripts can neither see nor change
 * them. Each declaration is composed from the source texts of the modules
 * `web_read` runs on jsdom (the vendored Readability, the reader, the
 * Markdown conversion, challenge detection), each of which reaches for
 * nothing outside itself and its arguments, so the page reads a rendered
 * document as jsdom reads a fetched one.
 */

/** What the reader is asked: whether the Markdown keeps link targets. */
export interface PageReadOptions {
  readonly links: boolean;
}

/** What the reader found: the page's article as Markdown, or null where Readability judges the page not readerable or finds no article with text in it. */
export interface PageArticle {
  readonly article: string | null;
}

/** The isolated world's global, where the reader lives once installed. */
interface ReaderGlobal {
  agentHarnessReader?: (options: PageReadOptions) => PageArticle;
}

/**
 * Puts the reader on the world's global, unless the world has it already:
 * Readability on a copy of the rendered document, its article converted to
 * Markdown. Every module is made afresh in this world from its arguments.
 */
export function installReaderWorld(
  readability: typeof mozillaReadability,
  readerable: typeof mozillaReaderable,
  markdown: typeof markdownModule,
  reader: typeof readerModule,
): void {
  const world = globalThis as ReaderGlobal;
  if (world.agentHarnessReader) return;
  const { readArticle } = reader(readability(), readerable());
  const { articleMarkdown } = markdown();
  world.agentHarnessReader = ({ links }) => {
    const article = readArticle(document);
    const text = article === null ? "" : articleMarkdown(article, { links });
    return { article: text.trim() === "" ? null : text };
  };
}

/** Makes the world's reader, once for its document: about 100 kB of source, sent the first time `readPage` finds the world without it. */
export const installReader: InPageSource<[], void> = {
  declaration: `function installReader() {
  (${installReaderWorld})(${mozillaReadability}, ${mozillaReaderable}, ${markdownModule}, ${readerModule});
}`,
};

/** Reads the frame's rendered document as the reader does. Null while the world has no reader: send `installReader` first. */
export function readPage(options: PageReadOptions): PageArticle | null {
  return (globalThis as ReaderGlobal).agentHarnessReader?.(options) ?? null;
}

/** The challenge the frame's document shows, named by kind, or null for none: #542's detection, run on the rendered page. */
export const pageChallenge: InPageSource<[], ChallengeKind | null> = {
  declaration: `function pageChallenge() {
  return (${challengeModule})((${pageTextModule})()).detectChallenge(document);
}`,
};
