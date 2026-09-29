import { describe, expect, it } from "vitest";
import { READ_PAGE_CHARS, pageStatement, pageText, type TextPage } from "./index.js";

/** A text of `n` characters, each position readable back from the text: "0123456789" repeated. */
const numbered = (n: number): string => "0123456789".repeat(Math.ceil(n / 10)).slice(0, n);

/** The page `pageText` answers, failing the test on a refusal. */
const page = (text: string, offset?: number): TextPage => {
  const answer = pageText(text, offset);
  if (!answer.ok) throw new Error(answer.reason);
  return answer.value;
};

describe("paging a long text", () => {
  const text = numbered(60_000);

  it("gives 24,000 characters a page, from the offset asked for, with the total length and the next offset", () => {
    expect(READ_PAGE_CHARS).toBe(24_000);
    expect(page(text)).toEqual({ text: text.slice(0, 24_000), offset: 0, totalChars: 60_000, nextOffset: 24_000 });
    expect(page(text, 24_000)).toEqual({ text: text.slice(24_000, 48_000), offset: 24_000, totalChars: 60_000, nextOffset: 48_000 });
    expect(page(text, 30_005)).toEqual({ text: text.slice(30_005, 54_005), offset: 30_005, totalChars: 60_000, nextOffset: 54_005 });
  });

  it("ends at the last page, which has no next offset", () => {
    expect(page(text, 48_000)).toEqual({ text: text.slice(48_000), offset: 48_000, totalChars: 60_000, nextOffset: null });
    expect(page("A short article.")).toEqual({ text: "A short article.", offset: 0, totalChars: 16, nextOffset: null });
    expect(page("")).toEqual({ text: "", offset: 0, totalChars: 0, nextOffset: null });
  });

  it("states where the page is, the total and the next offset, and says so on the last page", () => {
    expect(pageStatement(page(text))).toBe("Characters 0 to 24000 of 60000. The next page starts at offset 24000.");
    expect(pageStatement(page(text, 48_000))).toBe("Characters 48000 to 60000 of 60000: this is the last page.");
    expect(pageStatement(page(""))).toBe("The text is empty: this is the last page.");
  });

  it("answers an offset past the end with a sentence", () => {
    for (const offset of [60_000, 90_000]) {
      const answer = pageText(text, offset);
      expect(answer).toEqual({ ok: false, reason: `Offset ${offset} is past the end of the text, which is 60000 characters long: ask for an offset from 0 to 59999.` });
    }
    expect(pageText("", 1)).toEqual({ ok: false, reason: "Offset 1 is past the end of the text, which is empty: ask for offset 0." });
  });

  it("never cuts a character written as two code units in half, and its pages read back as the whole text", () => {
    const astral = `${numbered(23_999)}\u{1F986}${numbered(30_000)}\u{1F986}`;
    const first = page(astral);
    expect(first.text).toHaveLength(23_999);
    expect(first.nextOffset).toBe(23_999);
    const pages: string[] = [];
    for (let offset: number | null = 0; offset !== null; ) {
      const next = page(astral, offset);
      pages.push(next.text);
      offset = next.nextOffset;
    }
    expect(pages.join("")).toBe(astral);
    expect(pages.every((part) => !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(part))).toBe(true);
  });
});
