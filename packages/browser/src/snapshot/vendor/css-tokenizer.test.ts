import { describe, expect, it } from "vitest";
import { playwrightCssTokenizer } from "./css-tokenizer.js";

describe("the vendored CSS tokenizer", () => {
  it("writes every kind of token as JSON through its base class, where the copy it came from called its own toJSON again without end", () => {
    const { tokenize } = playwrightCssTokenizer();
    const tokens = tokenize(`"Note: " attr(title) 50% 2px #id ! 3`);
    expect(JSON.parse(JSON.stringify(tokens))).toEqual([
      { token: "STRING", value: "Note: " },
      { token: "WHITESPACE" },
      { token: "FUNCTION", value: "attr" },
      { token: "IDENT", value: "title" },
      { token: ")" },
      { token: "WHITESPACE" },
      { token: "PERCENTAGE", value: 50, repr: "50" },
      { token: "WHITESPACE" },
      { token: "DIMENSION", value: 2, type: "integer", repr: "2", unit: "px" },
      { token: "WHITESPACE" },
      { token: "HASH", value: "id", type: "id" },
      { token: "WHITESPACE" },
      { token: "DELIM", value: "!" },
      { token: "WHITESPACE" },
      { token: "NUMBER", value: 3, type: "integer", repr: "3" },
    ]);
  });
});
