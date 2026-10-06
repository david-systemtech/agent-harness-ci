// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Markdown } from "./markdown.js";

/** The selectors that draw the streaming caret and those that take it away, read from the stylesheet, `::after` dropped. */
const source = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const selectors = (rule: string) =>
  [...source.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => body?.includes(rule)).flatMap(([, list]) => split(list ?? "")).filter((one) => one.startsWith(".caret") && one.endsWith("::after")).map((one) => one.slice(0, -"::after".length));

/** A selector list cut at its top-level commas, not those inside `:is()`, `:has()` or `:not()`. */
const split = (list: string) => {
  const parts = [""];
  let depth = 0;
  for (const char of list) {
    depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    if (char === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts.map((one) => one.trim());
};

/** The elements the caret is drawn after while `text` streams. */
const carets = (text: string) => {
  const { container } = render(<div className="caret"><Markdown text={text} /></div>);
  const off = selectors("content: none");
  return [...container.querySelectorAll(selectors('content: ""').join(", "))].filter((element) => !off.some((one) => element.matches(one))).map((element) => `${element.tagName}:${element.textContent}`);
};

it.each([
  ["a paragraph", "One.\n\nTwo.", "P:Two."],
  ["a tight list", "- one\n- two", "LI:two"],
  ["a loose list", "- one\n\n- two", "P:two"],
  ["a nested list", "- one\n- two\n  - three", "LI:three"],
  ["a nested list not at the end", "- one\n  - inner\n- two", "LI:two"],
  ["a quote ending in a list", "> said\n>\n> - one\n> - two", "LI:two"],
])("draws one streaming caret, at the end of the last line, after %s", (_, text, at) => {
  expect(carets(text)).toEqual([at]);
});
