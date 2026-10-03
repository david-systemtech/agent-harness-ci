import type { CSSSourceCode, CSSSyntaxElement } from "@eslint/css";
import type { TSESTree } from "@typescript-eslint/utils";
import { readFileSync } from "node:fs";
import { createRule } from "./create-rule.js";
import { COLOUR_UTILITIES } from "./no-literal-colour.js";

/** The stylesheet is the authority: a token with no Tailwind mapping paints nothing. */
const stylesheet = readFileSync(new URL("../packages/gui/src/styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const mapped = new Set([...stylesheet.matchAll(/--color-([\w-]+)\s*:\s*var\(--[\w-]+\)/g)].map((match) => match[1]));
const prefixes = [...COLOUR_UTILITIES].sort((a, b) => b.length - a.length);

/** Overloaded colour prefixes also name sizes, alignment, geometry and styles in Tailwind 4. */
const nonColours: Readonly<Record<string, RegExp>> = {
  bg: /^(?:none|auto|cover|contain|fixed|local|scroll|(?:clip|origin)-(?:border|padding|content|text)|(?:no-)?repeat(?:-[xy]|-space|-round)?|(?:top|bottom|left|right|center)(?:-(?:top|bottom|left|right))?|(?:linear|radial|conic|gradient|blend|size|position)-.+)$/,
  text: /^(?:xs|sm|base|lg|xl|[2-9]xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip)$/,
  border: /^(?:solid|dashed|dotted|double|hidden|none|collapse|separate|spacing-.+)$/,
  divide: /^(?:[xy](?:-reverse|-\d+)?|solid|dashed|dotted|double|none)$/,
  decoration: /^(?:solid|double|dotted|dashed|wavy|auto|from-font)$/,
  outline: /^(?:solid|dashed|dotted|double|none|hidden|offset-\d+)$/,
  ring: /^inset$/,
  "ring-offset": /^\d+$/,
  shadow: /^(?:2xs|xs|sm|md|lg|xl|2xl|none|inner)$/,
  "inset-shadow": /^(?:2xs|xs|sm|none)$/,
  "drop-shadow": /^(?:xs|sm|md|lg|xl|2xl|none)$/,
  "text-shadow": /^(?:2xs|xs|sm|md|lg|none)$/,
  fill: /^none$/,
  stroke: /^none$/,
};

/** Strip variants and modifiers only outside arbitrary values/variants, whose colons and slashes belong to them. */
const utilityOf = (candidate: string): string => {
  let depth = 0;
  let start = 0;
  let end = candidate.length;
  for (let i = 0; i < candidate.length; i++) {
    const character = candidate[i];
    if (character === "\\") { i++; continue; }
    if (character === "[" || character === "(") depth++;
    else if (character === "]" || character === ")") depth--;
    else if (depth === 0 && character === ":") { start = i + 1; end = candidate.length; }
    else if (depth === 0 && character === "/" && end === candidate.length) end = i;
  }
  return candidate.slice(start, end).replace(/^!|!$/g, "");
};

const isUnmapped = (candidate: string): boolean => {
  const utility = utilityOf(candidate);
  // A bare side sets border width using currentColor, without naming a colour.
  if (/^border-(?:x|y|s|e|t|r|b|l|bs|be)$/.test(utility)) return false;
  const prefix = prefixes.find((name) => utility.startsWith(`${name}-`));
  if (!prefix) return false;
  const value = utility.slice(prefix.length + 1);
  if (!value || value.startsWith("[") || value.startsWith("(")) return false;
  if (mapped.has(value) || /^(?:transparent|current|inherit)$/.test(value)) return false;
  // Widths and gradient stop positions, including mask stops, are numbers rather than colours.
  if (/^(?:border(?:-(?:x|y|s|e|t|r|b|l|bs|be))?|divide|decoration|outline|ring|inset-ring|ring-offset|stroke|from|via|to|mask-.+-(?:from|to))$/.test(prefix) && /^\d+(?:\.\d+)?%?$/.test(value)) return false;
  const family = prefix.startsWith("border-") ? "border" : prefix;
  return !nonColours[family]?.test(value);
};

/** Static strings are checked wherever held: JSX, class helpers, object keys and template literal's complete classes. */
export const rule = createRule<[], "unmapped">({
  name: "no-unmapped-colour-class",
  meta: {
    type: "problem",
    docs: { description: "Colour utilities must name a mapped theme token (ADR 0023)." },
    schema: [],
    messages: { unmapped: "'{{colour}}' names no mapped colour token in packages/gui/src/styles.css. Use a mapped token (bg-panel, text-ink, shadow-scrim)." },
  },
  defaultOptions: [],
  create(context) {
    const check = (node: object, text: string) => {
      for (const colour of text.split(/\s+/).filter(isUnmapped)) {
        context.report({ node: node as TSESTree.Node, messageId: "unmapped", data: { colour } });
      }
    };
    const source = context.sourceCode;
    if ((source.ast.type as string) === "StyleSheet") {
      const cssSource = source as unknown as CSSSourceCode;
      return { Atrule(node: CSSSyntaxElement) {
        if (node.type === "Atrule" && node.name === "apply" && node.prelude) check(node.prelude, cssSource.getText(node.prelude));
      } };
    }
    if ((source.ast.body[0]?.type as string) === "Document") {
      return { Attribute(node: { key: { value: string }; value?: { value: string } }) {
        if (node.key.value === "class" && node.value) check(node.value, node.value.value);
      } };
    }
    return {
      Literal(node) { if (typeof node.value === "string") check(node, node.value); },
      TemplateLiteral(node) {
        for (const [i, quasi] of node.quasis.entries()) {
          let text = quasi.value.cooked ?? quasi.value.raw;
          // Ignore only class fragments attached to an interpolation, rather than treating them as whole utilities.
          if (i > 0) text = text.replace(/^\S*/, "");
          if (i < node.quasis.length - 1) text = text.replace(/\S*$/, "");
          check(quasi, text);
        }
      },
    };
  },
});
