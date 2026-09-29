/**
 * `@path` completion: the ranking and the token, without the tests of the
 * listing, which is `files.list` on the environment and is tested there, or
 * of the terminal UI's memory of picks, which are its own.
 *
 * The failure mode of a completion is not crashing, it is offering the wrong
 * file first — which no type can catch and a person notices immediately. So the
 * scorer's cases are written as the orderings they have to produce, with a
 * fixed list of paths and no filesystem, and the two that a greedy matcher gets
 * wrong (`co/Comp`, and a filename typed out in full) are pinned by name.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_MATCH_LIMIT, fuzzyMatch, mentionAt, replaceMention } from "./mentions.js";

/** A fixed corpus: every ordering below is a claim about these seven paths. */
const PATHS: readonly string[] = [
  "apps/tui/src/components/Composer.tsx",
  "apps/tui/src/components/ComposerActions.tsx",
  "packages/core/src/adapters/compose.ts",
  "apps/tui/src/commands.ts",
  "docs/composer.md",
  "packages/core/src/index.ts",
  "apps/tui/src/app.tsx",
];

const ranked = (query: string, paths: readonly string[] = PATHS): readonly string[] => fuzzyMatch(query, paths).map((match) => match.path);

describe("fuzzyMatch", () => {
  it("prefers the file the query describes over the one that merely contains the letters", () => {
    // The case a greedy scan gets wrong: it lands `co` on `core` and stops,
    // never noticing that `components` offers the same run one segment from a
    // file actually called `Composer`.
    expect(ranked("co/Comp")).toEqual([
      "apps/tui/src/components/Composer.tsx",
      "apps/tui/src/components/ComposerActions.tsx",
      "packages/core/src/adapters/compose.ts",
    ]);
  });

  it("puts a filename typed out in full first", () => {
    // Typing a whole basename is an answer, not a query, and must not be
    // out-argued by a longer path that happens to contain the same letters.
    expect(ranked("Composer.tsx")).toEqual(["apps/tui/src/components/Composer.tsx", "apps/tui/src/components/ComposerActions.tsx"]);
  });

  it("matches case-insensitively and reports the offsets in the path as written", () => {
    const [best] = fuzzyMatch("comp", ["apps/tui/src/components/Composer.tsx"]);

    // The basename beats the directory of the same name, and the indices point
    // at the original characters so a highlight can be drawn over them.
    expect(best?.indices).toEqual([24, 25, 26, 27]);
    expect(best?.indices.map((index) => best.path.charAt(index)).join("")).toBe("Comp");
  });

  it("scores the start of the basename above the start of the path", () => {
    const [best] = fuzzyMatch("app", ["apps/tui/src/app.tsx"]);

    expect(best?.indices).toEqual([13, 14, 15]);
  });

  it("drops a path whose characters are not all there, in order", () => {
    expect(ranked("zq")).toEqual([]);
    // `x` never appears in this one, so a subsequence is impossible.
    expect(ranked("composex", ["packages/core/src/adapters/compose.ts"])).toEqual([]);
  });

  it("returns at most the limit, twelve by default", () => {
    expect(DEFAULT_MATCH_LIMIT).toBe(12);
    expect(fuzzyMatch("s", PATHS, { limit: 2 })).toHaveLength(2);
    expect(fuzzyMatch("s", PATHS, { limit: 0 })).toEqual([]);
    expect(fuzzyMatch("", PATHS, { limit: 3 })).toHaveLength(3);
  });

  it("breaks a tie on the shorter path, then on path order", () => {
    expect(ranked("one", ["b/one.ts", "a/one.ts", "a/one.longer.ts"])).toEqual(["a/one.ts", "b/one.ts", "a/one.longer.ts"]);
  });

  it("lets what was picked before win between otherwise equal paths", () => {
    const frecency = { boost: (path: string): number => (path === "b/one.ts" ? 10 : 0) };

    expect(fuzzyMatch("one", ["a/one.ts", "b/one.ts"], { frecency }).map((match) => match.path)).toEqual(["b/one.ts", "a/one.ts"]);
  });

  it("offers what was picked before, then alphabetical, when nothing has been typed", () => {
    const paths = ["docs/composer.md", "apps/tui/src/app.tsx", "packages/core/src/index.ts"];
    const frecency = { boost: (path: string): number => (path === "packages/core/src/index.ts" ? 20 : 0) };

    const results = fuzzyMatch("   ", paths, { frecency });

    expect(results.map((match) => match.path)).toEqual(["packages/core/src/index.ts", "apps/tui/src/app.tsx", "docs/composer.md"]);
    // Nothing was typed, so there is nothing to highlight.
    expect(results.map((match) => match.indices)).toEqual([[], [], []]);
  });
});

describe("mentionAt", () => {
  it("finds a token at the start of the text and one after whitespace", () => {
    expect(mentionAt("@app", 4)).toEqual({ start: 0, end: 4, query: "app" });
    expect(mentionAt("look at @src/app.tsx", 20)).toEqual({ start: 8, end: 20, query: "src/app.tsx" });
  });

  it("is the whole token wherever in it the cursor sits", () => {
    // Arrowing back to fix a letter must not narrow the list to a prefix.
    expect(mentionAt("see @apps/tui here", 8)).toEqual({ start: 4, end: 13, query: "apps/tui" });
    expect(mentionAt("see @apps/tui here", 5)).toEqual({ start: 4, end: 13, query: "apps/tui" });
  });

  it("is an empty query the moment the @ is typed", () => {
    expect(mentionAt("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(mentionAt("hi @", 4)).toEqual({ start: 3, end: 4, query: "" });
  });

  it("is nothing inside an email address", () => {
    // The `@` is mid-token, so it does not start one.
    expect(mentionAt("ada@example.com", 12)).toBeNull();
    expect(mentionAt("mail @ada ada@example.com", 25)).toBeNull();
  });

  it("allows an @ inside the path, which scoped package folders have", () => {
    const text = "see @node_modules/@scope/thing";

    expect(mentionAt(text, text.length)).toEqual({ start: 4, end: 30, query: "node_modules/@scope/thing" });
  });

  it("is nothing when the cursor is on or before the @, or past the token", () => {
    expect(mentionAt("@app", 0)).toBeNull();
    expect(mentionAt("hi @app", 3)).toBeNull();
    expect(mentionAt("@app here", 9)).toBeNull();
    expect(mentionAt("hi ", 3)).toBeNull();
    expect(mentionAt("", 0)).toBeNull();
    expect(mentionAt("@app", 99)).toBeNull();
  });
});

describe("replaceMention", () => {
  it("writes over the token, @ and all, and leaves the cursor past one space", () => {
    const mention = mentionAt("see @app here", 8);

    expect(mention).not.toBeNull();
    expect(mention && replaceMention("see @app here", mention.start, mention.end, "apps/tui/src/app.tsx")).toEqual({
      text: "see apps/tui/src/app.tsx here",
      cursor: 25,
    });
  });

  it("adds the space at the end of the line, and does not double one already there", () => {
    expect(replaceMention("see @app", 4, 8, "x.ts")).toEqual({ text: "see x.ts ", cursor: 9 });
    expect(replaceMention("see @app there", 4, 8, "x.ts")).toEqual({ text: "see x.ts there", cursor: 9 });
  });
});
