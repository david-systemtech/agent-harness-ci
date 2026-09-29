import type { PageRefusal } from "@agent-harness/contracts";

/**
 * Paging (browser spec, "`browser_read`" and "`web_read`"): a long text read
 * to its end a page at a time, by offset, in place of a cut that loses what
 * comes after it. Offsets count characters as the text's code units, the
 * way every transport and the model's next call count them.
 */

/** How many characters a page holds. */
export const READ_PAGE_CHARS = 24_000;

/** One page of a text: where it starts, the whole text's length, and where the next page starts, null on the last. */
export interface TextPage {
  readonly text: string;
  readonly offset: number;
  readonly totalChars: number;
  readonly nextOffset: number | null;
}

/** Whether the code unit at `at` opens a character written as two, which a cut after it would halve. */
const opensPair = (text: string, at: number): boolean => {
  const unit = text.charCodeAt(at);
  return unit >= 0xd800 && unit <= 0xdbff;
};

/**
 * The page of `text` that starts at `offset` (preset 0): 24,000 characters,
 * one fewer where the last would open a character written as two code
 * units, so no page ends or starts inside one. An offset past the end is a
 * refusal sentence saying how long the text is, and so is one that is no
 * whole number from 0.
 */
export const pageText = (text: string, offset = 0): { readonly ok: true; readonly value: TextPage } | PageRefusal => {
  const totalChars = text.length;
  if (!Number.isInteger(offset) || offset < 0) return { ok: false, reason: `Offset ${offset} is no place in the text: an offset is a whole number of characters from 0.` };
  if (offset > 0 && offset >= totalChars) {
    const reason =
      totalChars === 0
        ? `Offset ${offset} is past the end of the text, which is empty: ask for offset 0.`
        : `Offset ${offset} is past the end of the text, which is ${totalChars} characters long: ask for an offset from 0 to ${totalChars - 1}.`;
    return { ok: false, reason };
  }
  let end = Math.min(offset + READ_PAGE_CHARS, totalChars);
  if (end < totalChars && opensPair(text, end - 1)) end -= 1;
  return { ok: true, value: { text: text.slice(offset, end), offset, totalChars, nextOffset: end < totalChars ? end : null } };
};

/** Where a page is in its text, stated for the model: its span, the total and the next offset, or that it is the last. */
export const pageStatement = (page: TextPage): string => {
  if (page.totalChars === 0) return "The text is empty: this is the last page.";
  const span = `Characters ${page.offset} to ${page.offset + page.text.length} of ${page.totalChars}`;
  return page.nextOffset === null ? `${span}: this is the last page.` : `${span}. The next page starts at offset ${page.nextOffset}.`;
};
