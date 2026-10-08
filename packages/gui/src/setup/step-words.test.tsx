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

/** §2's "What is this?" sentences by the word they explain: the table's third column by its first. */
const glossary = new Map(
  copy.slice(copy.indexOf("## 2. Words"), copy.indexOf("## 3. "))
    .split("\n").filter((line) => line.startsWith("| ")).map((line) => line.slice(2).split(" | "))
    .map(([use = "", , sentence = ""]) => [use.trim(), sentence.replace(/\|$/, "").trim()] as const).filter(([, sentence]) => sentence.endsWith(".")),
);

/** The §2 words each step without a §5 sentence of its own uses, by their row's first cell, and the word its §5 section says. */
const USES: { readonly [Id in StepId]?: readonly (readonly [row: string, said: string])[] } = {
  "your-machines": [["this computer / {name}", "this computer"], ["Tailscale", "Tailscale"]],
  forges: [["forge (code host)", "forge"], ["token", "token"]],
  "key-manager": [["key manager", "key manager"]],
  "memory-bank": [["memory bank (notebook)", "notebook"]],
  skills: [["skill, skill collection", "skill"]],
  permissions: [["sandbox", "sandbox"], ["always-ask list", "always-ask list"]],
};

it.each(STEP_ORDER)("gives %s the heading and why line of its §5 section, word for word", (step) => {
  const head = /^- Title `([^`]+)`\.? Why `([^`]+)`/m.exec(section(step));
  expect(STEP_WORDS[step]).toMatchObject({ heading: head?.[1], why: head?.[2] });
});

it.each(STEP_ORDER)("gives %s its §5 \"What is this?\" sentence, else §2's sentences for the words it uses, else none", (step) => {
  const own = /^- What is this\? `([^`]+)`/m.exec(section(step))?.[1];
  const { what } = STEP_WORDS[step];
  if (own !== undefined) return expect(what).toBe(own);
  const uses = USES[step] ?? [];
  for (const [, said] of uses) expect(section(step).toLowerCase()).toContain(said.toLowerCase());
  expect(what).toBe(uses.length === 0 ? undefined : uses.map(([row]) => glossary.get(row)).join(" "));
});

it("leaves the fold off the steps whose words need no explaining", () => {
  expect(STEP_ORDER.filter((step) => STEP_WORDS[step].what === undefined)).toEqual(["account", "appearance"]);
});
