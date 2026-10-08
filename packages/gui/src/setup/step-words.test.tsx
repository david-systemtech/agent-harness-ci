// @vitest-environment jsdom-on-node
import { readFileSync } from "node:fs";
import { STEP_LABELS, STEP_ORDER, type StepId } from "@agent-harness/contracts";
import { expect, it } from "vitest";
import { STEP_WORDS } from "./step-words.js";

/** The words' one source (docs/specs/setup-copy.md): builders copy its strings exactly. */
const copy = readFileSync(new URL("../../../../docs/specs/setup-copy.md", import.meta.url), "utf8");

/** §5's section of a step, from its heading to the next. */
const section = (step: StepId): string => {
  const heading = new RegExp(`^### 5\\.\\d+ ${STEP_LABELS[step]} \\(`, "m").exec(copy);
  expect(heading, STEP_LABELS[step]).not.toBeNull();
  const rest = copy.slice((heading?.index ?? 0) + 4);
  return rest.slice(0, rest.search(/^#{2,3} /m));
};

/** §2's "What is this?" sentences, the table's third column. */
const glossary = copy.slice(copy.indexOf("## 2. Words"), copy.indexOf("## 3. "))
  .split("\n").filter((line) => line.startsWith("| ")).map((line) => line.split(" | ")[2]?.replace(/\|$/, "").trim() ?? "").filter((cell) => cell.endsWith("."));

it.each(STEP_ORDER)("gives %s the heading and why line of its §5 section, word for word", (step) => {
  const head = /^- Title `([^`]+)`\.? Why `([^`]+)`/m.exec(section(step));
  expect(STEP_WORDS[step]).toMatchObject({ heading: head?.[1], why: head?.[2] });
});

it.each(STEP_ORDER)("gives %s its §5 \"What is this?\" sentence, else §2's sentences for the words it uses, else none", (step) => {
  const own = /^- What is this\? `([^`]+)`/m.exec(section(step))?.[1];
  const { what } = STEP_WORDS[step];
  if (own !== undefined) expect(what).toBe(own);
  else if (what !== undefined) {
    let left = what;
    for (const sentence of glossary) left = left.replace(sentence, "");
    expect(left.trim(), what).toBe("");
  }
});

it("leaves the fold off the steps whose words need no explaining", () => {
  expect(STEP_ORDER.filter((step) => STEP_WORDS[step].what === undefined)).toEqual(["account", "appearance"]);
});
