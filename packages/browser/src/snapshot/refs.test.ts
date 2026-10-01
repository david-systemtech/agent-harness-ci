import { describe, expect, it } from "vitest";
import { RefBook } from "./refs.js";

/**
 * Ref names (browser spec, "The tools"): `e12` in the page's top frame, and
 * the same prefixed for a child frame, `f1e3`, so a ref names its frame; a
 * frame's refs go on counting across its documents, so no ref an older
 * snapshot gave is given again to another element.
 */

describe("RefBook", () => {
  it("gives the top frame no prefix and each other frame its own, in the order snapshots first meet them", () => {
    const book = new RefBook();
    expect(book.prefixOf("top", true)).toBe("");
    expect(book.prefixOf("reviews", false)).toBe("f1");
    expect(book.prefixOf("payment", false)).toBe("f2");
    expect(book.prefixOf("reviews", false)).toBe("f1");
    expect(book.prefixOf("top", true)).toBe("");
  });

  it("never gives a prefix twice, though its frame has gone", () => {
    const book = new RefBook();
    book.prefixOf("ad-slot", false);
    expect(book.prefixOf("ad-slot-again", false)).toBe("f2");
  });

  it("names the frame a ref is from by its prefix, and none for what no snapshot gave", () => {
    const book = new RefBook();
    book.prefixOf("top", true);
    book.prefixOf("reviews", false);
    expect(book.frameOf("e12")).toBe("top");
    expect(book.frameOf("f1e3")).toBe("reviews");
    expect(book.frameOf("f7e3")).toBeUndefined();
    expect(book.frameOf("button")).toBeUndefined();
    expect(book.frameOf("e")).toBeUndefined();
    expect(book.frameOf("f1")).toBeUndefined();
  });

  it("asks each frame's next snapshot to number past the highest ref the frame has given", () => {
    const book = new RefBook();
    expect(book.firstRefOf("top")).toBe(1);
    book.gave("top", 12);
    expect(book.firstRefOf("top")).toBe(13);
    book.gave("top", 3);
    expect(book.firstRefOf("top")).toBe(13);
    expect(book.firstRefOf("reviews")).toBe(1);
  });
});
