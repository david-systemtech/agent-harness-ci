import { parentPort } from "node:worker_threads";
import { readFetchedPage } from "@agent-harness/browser";
import type { ExtractionJob, Extracted, PageRange } from "./extraction.js";

/**
 * The extraction worker (`extraction.ts`): handed one fetched body, it reads
 * it into text and answers once. HTML goes through the browser package's
 * reader on jsdom, which runs no script and loads nothing; a PDF through
 * pdf.js, text per page; text as it is. Whatever throws (a page that names
 * an element after a DOM method breaks the reader, #696; a PDF pdf.js cannot
 * parse) is answered as a sentence.
 */

/** The charset a Content-Type names, preset UTF-8. */
const charsetOf = (contentType: string): string | null => /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? null;

/** Text in the charset its type names, UTF-8 where it names none or one the platform does not know. */
const decoded = (bytes: Uint8Array, contentType: string): string => {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
};

/**
 * A page in jsdom: as HTML whatever its declared type (an XHTML page read
 * leniently), the charset from its type, else its own `meta` or byte order
 * mark, which jsdom reads from the bytes. Its console goes nowhere.
 */
const readHtml = async (job: ExtractionJob): Promise<Extracted> => {
  const { JSDOM, VirtualConsole } = await import("jsdom");
  const charset = charsetOf(job.contentType);
  const { window } = new JSDOM(Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength), {
    url: job.url,
    contentType: charset === null ? "text/html" : `text/html; charset=${charset}`,
    virtualConsole: new VirtualConsole(),
  });
  return readFetchedPage(window.document);
};

/** A text content item of pdf.js: a run of text and whether a line ends after it; marked content carries no text. */
interface TextItem {
  readonly str?: string;
  readonly hasEOL?: boolean;
}

/** A page's text as pdf.js lays its items out: each run, a line break where one ends a line, trailing spaces trimmed. */
const pageText = (items: readonly TextItem[]): string =>
  items
    .map((item) => `${item.str ?? ""}${item.hasEOL === true ? "\n" : ""}`)
    .join("")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

/**
 * A PDF's pages (all, or the range asked for, its end held to the last
 * page) as text, each under a heading naming its number. pdf.js runs with
 * no script evaluation and no fonts loaded: only the text is wanted.
 */
const readPdf = async (job: ExtractionJob): Promise<Extracted> => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: job.bytes, disableFontFace: true, useSystemFonts: false, verbosity: pdfjs.VerbosityLevel.ERRORS })
    .promise;
  const totalPages = document.numPages;
  const range: PageRange = job.pages ?? { from: 1, to: totalPages };
  if (range.from > totalPages) {
    return { kind: "failed", reason: `The PDF has ${totalPages} page${totalPages === 1 ? "" : "s"}: page ${range.from} is past its end. Ask for pages from 1 to ${totalPages}.` };
  }
  const to = Math.min(range.to, totalPages);
  const pages: string[] = [];
  for (let number = range.from; number <= to; number++) {
    const page = await document.getPage(number);
    const content = await page.getTextContent();
    pages.push(`## Page ${number}\n\n${pageText(content.items as readonly TextItem[])}`);
    page.cleanup();
  }
  return { kind: "pdf", markdown: pages.join("\n\n"), totalPages, from: range.from, to };
};

const extract = (job: ExtractionJob): Promise<Extracted> => {
  switch (job.bodyKind) {
    case "html":
      return readHtml(job);
    case "pdf":
      return readPdf(job);
    case "text":
      return Promise.resolve({ kind: "text", markdown: decoded(job.bytes, job.contentType) });
  }
};

const port = parentPort;
if (port === null) throw new Error("The extraction worker runs on a worker thread.");
port.once("message", (job: ExtractionJob) => {
  extract(job)
    .catch((error: unknown): Extracted => ({ kind: "failed", reason: `The reader could not read it: ${error instanceof Error ? error.message : String(error)}` }))
    .then((extracted) => port.postMessage(extracted));
});
