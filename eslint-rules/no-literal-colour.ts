import { CSSLanguage, type CSSSourceCode, type CSSSyntaxElement } from "@eslint/css";
import { AST_NODE_TYPES, ASTUtils, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { createRule } from "./create-rule.js";

/**
 * ADR 0023: every colour a renderer paints is a token, so no literal colour
 * may stand in a renderer package's source, stylesheets, SVG assets or HTML
 * documents (docs/specs/gui.md, "Theme: tokens, the setting and the lint").
 * The configuration scopes it to the packages that paint with the theme's
 * tokens and names the two places allowlisted: xterm's fallback theme and the
 * preview frame's content.
 *
 * Refused:
 * - a hex colour of three, four, six or eight digits, and a literal colour
 *   function (`COLOUR_FUNCTION`: `rgb()`, `hsl()`, `oklch()`, `color()`, their
 *   alpha forms, and `hwb()`, `lab()`, `lch()` and `oklab()`), in every string
 *   and template literal (a JSX attribute's and a style object's included) and
 *   in a stylesheet's every declaration (custom properties and a token's
 *   fallback included) and `@apply`;
 * - Tailwind's palette classes (a colour utility of `COLOUR_UTILITIES` with a
 *   `TAILWIND_HUES` hue and a `TAILWIND_SHADES` shade), the `black` and `white`
 *   utilities, and an arbitrary value or property holding a named colour
 *   (`bg-[red]`, `[color:navy]`), behind any variants, in every string (a
 *   class string, joined by a class helper or held in a variable, is one) and
 *   in a stylesheet's `@apply`; a hex or colour function in an arbitrary value
 *   is refused as a literal; and the same palette through Tailwind's theme
 *   variables (`var(--color-red-500)`, `bg-(--color-white)`), in every string,
 *   declaration and `@apply`;
 * - a named colour keyword (`NAMED_COLOURS`) in a style: a stylesheet's
 *   declaration, a style object's values (a `style` attribute's, an object it
 *   names through a variable or spreads, one typed `CSSProperties`, and the
 *   DOM's `element.style`), and an SVG element's colour attributes
 *   (`SVG_COLOUR_ATTRIBUTES`), since logos use `currentColor`. A colour name
 *   anywhere else is data, such as an environment's colour, and passes.
 *
 * An SVG asset or an HTML document (html-eslint's HTML language parses both)
 * is read as a script is: every attribute's value is a string, and a `style`
 * attribute, an SVG colour attribute and the `content` of
 * `<meta name="theme-color">` are styles; a `<style>` element is a stylesheet,
 * parsed as a stylesheet file is, a CDATA section around it included.
 *
 * A token (`var(--beam)`, `bg-(--beam)`, a class the theme maps such as
 * `bg-beam`), `currentColor`, `transparent` and `inherit` pass everywhere, as
 * does a relative colour whose origin is a token or `currentColor`
 * (`oklch(from var(--beam) l c h / 50%)`) and a mix of them (`color-mix()`).
 * Not read: quoted text inside a CSS value, a `url()`'s argument, selectors,
 * comments, JSX text, a document's text and an inline `<script>`'s body (a
 * painting package's document loads its scripts as modules, which are read).
 * A string shaped exactly like a hex colour is refused whatever it means
 * (`"#454"`): write such text from data.
 */

/** A hex colour of three, four, six or eight digits, not inside a word, an entity (`&#123;`) or a longer run. */
const HEX = /(?<![0-9a-z&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z-])/;

/** The start of a literal colour function. */
const COLOUR_FUNCTION = /(?<![0-9a-z-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/;

/** Either, ignoring case. */
const LITERAL = new RegExp(`${HEX.source}|${COLOUR_FUNCTION.source}`, "gi");

/**
 * A relative colour's origin that is a token or `currentColor`, after the function's parenthesis: the colour is the theme's.
 * A space may be Tailwind's `_` in an arbitrary value (`rgb(from_currentColor_r_g_b)`).
 */
const FROM_TOKEN = /^[\s_]*from[\s_]+(?:var\(|currentcolor(?![0-9a-z-]))/i;

/** A `url()`, whose argument (`url(#fade)`) names a resource, not a colour. */
const URL = /url\([^)]*\)/gi;

/** A quoted string in a CSS value, whose words are text, not colours. */
const QUOTED = /"[^"]*"|'[^']*'/g;

/** A word in a CSS value: `red` in `1px solid red`, not `--red` or `red-500`. */
const WORD = /(?<![\w-])[a-z]+(?![\w-])/gi;

/** CSS's named colours (CSS Color 4): every keyword that names a colour but `transparent` and `currentColor`. */
const NAMED_COLOURS: ReadonlySet<string> = new Set(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue " +
    "chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey " +
    "darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray " +
    "darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen " +
    "fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen " +
    "lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime " +
    "limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive " +
    "olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver " +
    "skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

/** Tailwind 4's palette: every hue and shade its default theme defines (`tailwindcss/theme.css` at 4.3). */
const TAILWIND_HUES = [
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet",
  "purple", "fuchsia", "pink", "rose", "slate", "gray", "zinc", "neutral", "stone", "mauve", "olive", "mist", "taupe",
];
const TAILWIND_SHADES = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];

/** Every Tailwind 4 utility that takes a colour: the prefixes of the classes its design system lists for `white` at 4.3. */
export const COLOUR_UTILITIES = [
  "accent", "bg", "caret", "decoration", "divide", "drop-shadow", "fill", "from", "via", "to", "inset-ring", "inset-shadow",
  "outline", "placeholder", "ring", "ring-offset", "scrollbar-thumb", "scrollbar-track", "shadow", "stroke", "text", "text-shadow",
  ...["", "-x", "-y", "-s", "-e", "-t", "-r", "-b", "-l", "-bs", "-be"].map((side) => `border${side}`),
  ...["b", "t", "l", "r", "x", "y", "linear", "radial", "conic"].flatMap((edge) => [`mask-${edge}-from`, `mask-${edge}-to`]),
];

/** A colour utility with a palette colour, `black`, `white` or an arbitrary value, or an arbitrary property; an opacity modifier after it. */
const TAILWIND_COLOUR = new RegExp(
  `^(?:(?:${COLOUR_UTILITIES.join("|")})-(?:(?:${TAILWIND_HUES.join("|")})-(?:${TAILWIND_SHADES.join("|")})|black|white|\\[(?<value>.+)\\])|\\[[a-z-]+:(?<property>.+)\\])(?:/\\S+)?$`,
);

/** Tailwind's palette as its theme variables (`var(--color-red-500)`, `bg-(--color-white)`): the palette, not a token. */
const PALETTE_VARIABLE = new RegExp(`(?<![\\w-])--color-(?:(?:${TAILWIND_HUES.join("|")})-(?:${TAILWIND_SHADES.join("|")})|black|white)(?![\\w-])`, "g");

/** An SVG element's presentation attributes that take a colour, as React spells them and as SVG does. */
const SVG_COLOUR_ATTRIBUTES: ReadonlySet<string> = new Set([
  "fill",
  "stroke",
  "color",
  "stopColor",
  "stop-color",
  "floodColor",
  "flood-color",
  "lightingColor",
  "lighting-color",
]);

type MessageId = "literal" | "tailwind" | "named";

/** A colour found in a text, and the message it is reported with. */
interface Found {
  readonly colour: string;
  readonly messageId: MessageId;
}

// Reading colours out of text.

/** `text` with each match of `pattern` blanked, its indices kept. */
const blank = (text: string, pattern: RegExp): string => text.replace(pattern, (m) => " ".repeat(m.length));

/** The call starting at `start` up to its closing parenthesis, or to the end of `text` if it is cut there. */
const callAt = (text: string, start: number): string => {
  let depth = 0;
  for (let i = text.indexOf("(", start); i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
};

/**
 * The hex colours and literal colour functions in a text, each once (a hex
 * inside a refused function is that function's), and the text left with them
 * and its `url()`s blanked.
 */
const literalsIn = (text: string): { found: Found[]; rest: string } => {
  const found: Found[] = [];
  let rest = blank(text, URL);
  let end = 0;
  for (const m of rest.matchAll(LITERAL)) {
    if (m.index < end) continue;
    if (!m[0].startsWith("#") && FROM_TOKEN.test(text.slice(m.index + m[0].length))) continue;
    const colour = m[0].startsWith("#") ? m[0] : callAt(text, m.index);
    found.push({ colour, messageId: "literal" });
    end = m.index + colour.length;
    rest = rest.slice(0, m.index) + " ".repeat(colour.length) + rest.slice(end);
  }
  return { found, rest };
};

/** Tailwind's palette variables named in a text. */
const paletteVariables = (text: string): Found[] => [...text.matchAll(PALETTE_VARIABLE)].map((m) => ({ colour: m[0], messageId: "tailwind" }));

/** The colours in a CSS value: its literals, its named colours outside them and Tailwind's palette variables. Quoted text is not read. */
const valueColours = (value: string): Found[] => {
  const unquoted = blank(value, QUOTED);
  const { found, rest } = literalsIn(unquoted);
  const named = [...rest.matchAll(WORD)].filter((m) => NAMED_COLOURS.has(m[0].toLowerCase()));
  return [...found, ...named.map((m): Found => ({ colour: m[0], messageId: "named" })), ...paletteVariables(unquoted)];
};

/** A class's utility: what follows its last variant (`hover:`, `data-[state=open]:`), without the important mark. */
const utilityOf = (candidate: string): string => {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < candidate.length; i++) {
    const c = candidate[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) start = i + 1;
  }
  return candidate.slice(start).replace(/^!|!$/g, "");
};

/** Whether a Tailwind class paints a colour outside the theme. A hex or colour function in an arbitrary value is the literal's to report. */
const isTailwindColour = (candidate: string): boolean => {
  const match = TAILWIND_COLOUR.exec(utilityOf(candidate));
  if (!match) return false;
  const arbitrary = match.groups?.["value"] ?? match.groups?.["property"];
  return arbitrary === undefined || valueColours(arbitrary.replaceAll("_", " ")).some((f) => f.messageId === "named");
};

/** The Tailwind classes in a class string that paint a colour outside the theme. */
const tailwindColours = (classes: string): Found[] =>
  classes
    .split(/\s+/)
    .filter(isTailwindColour)
    .map((colour) => ({ colour, messageId: "tailwind" }));

/** The colours in a string that may hold classes (a script's string, a stylesheet's `@apply`): Tailwind's, its palette variables and the literals. */
const classStringColours = (text: string): Found[] => [...tailwindColours(text), ...paletteVariables(text), ...literalsIn(text).found];

// Scripts.

/** A type naming a style object: `CSSProperties`, `React.CSSProperties`. */
const isStyleType = (type: TSESTree.TypeNode | undefined): boolean => {
  if (type?.type !== AST_NODE_TYPES.TSTypeReference) return false;
  const name = type.typeName.type === AST_NODE_TYPES.TSQualifiedName ? type.typeName.right : type.typeName;
  return name.type === AST_NODE_TYPES.Identifier && name.name.endsWith("CSSProperties");
};

/** `x.style`, the DOM's style object. */
const isStyleMember = (node: TSESTree.Node): boolean =>
  node.type === AST_NODE_TYPES.MemberExpression &&
  !node.computed &&
  node.property.type === AST_NODE_TYPES.Identifier &&
  node.property.name === "style";

/**
 * The strings and object literals an expression may evaluate to: through
 * either branch of a condition or a logical expression, TypeScript's
 * assertions, and a variable to the value it was declared with.
 */
const valuesOf = (node: TSESTree.Node | null | undefined, scope: TSESLint.Scope.Scope, seen: Set<TSESTree.Node>): TSESTree.Node[] => {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  switch (node.type) {
    case AST_NODE_TYPES.Literal:
    case AST_NODE_TYPES.TemplateLiteral:
    case AST_NODE_TYPES.ObjectExpression:
      return [node];
    case AST_NODE_TYPES.JSXExpressionContainer:
    case AST_NODE_TYPES.TSAsExpression:
    case AST_NODE_TYPES.TSSatisfiesExpression:
    case AST_NODE_TYPES.TSNonNullExpression:
      return valuesOf(node.expression, scope, seen);
    case AST_NODE_TYPES.ConditionalExpression:
      return [...valuesOf(node.consequent, scope, seen), ...valuesOf(node.alternate, scope, seen)];
    case AST_NODE_TYPES.LogicalExpression:
      return [...valuesOf(node.left, scope, seen), ...valuesOf(node.right, scope, seen)];
    case AST_NODE_TYPES.Identifier: {
      const definition = ASTUtils.findVariable(scope, node)?.defs[0]?.node;
      return definition?.type === AST_NODE_TYPES.VariableDeclarator ? valuesOf(definition.init, scope, seen) : [];
    }
    default:
      return [];
  }
};

/** Every string in a style: its values, nested objects' (`"&:hover": {}`) and spread objects' included, never its keys. */
const styleStrings = (node: TSESTree.Node | null | undefined, scope: TSESLint.Scope.Scope, seen = new Set<TSESTree.Node>()): TSESTree.Node[] =>
  valuesOf(node, scope, seen).flatMap((value) =>
    value.type === AST_NODE_TYPES.ObjectExpression
      ? value.properties.flatMap((p) => styleStrings(p.type === AST_NODE_TYPES.Property ? p.value : p.argument, scope, seen))
      : [value],
  );

/** A string node's text: a literal's value, a template's static parts. */
const textOf = (node: TSESTree.Node): string => {
  if (node.type === AST_NODE_TYPES.Literal) return typeof node.value === "string" ? node.value : "";
  if (node.type === AST_NODE_TYPES.TemplateLiteral) return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
  return "";
};

type Context = Readonly<TSESLint.RuleContext<MessageId, []>>;

const scriptVisitors = (context: Context): TSESLint.RuleListener => {
  const report = (node: TSESTree.Node, { colour, messageId }: Found) => context.report({ node, messageId, data: { colour } });
  const styled = new Set<TSESTree.Node>();
  /** Report the named colours of each string a style holds, once per string; its literals are every string's. */
  const checkStyle = (node: TSESTree.Node | null | undefined, at: TSESTree.Node) => {
    for (const value of styleStrings(node, context.sourceCode.getScope(at))) {
      if (styled.has(value)) continue;
      styled.add(value);
      for (const found of valueColours(textOf(value))) if (found.messageId === "named") report(value, found);
    }
  };
  const checkString = (node: TSESTree.Node, text: string) => {
    for (const found of classStringColours(text)) report(node, found);
  };
  return {
    Literal(node) {
      if (typeof node.value === "string") checkString(node, node.value);
    },
    TemplateElement(node) {
      checkString(node, node.value.cooked ?? node.value.raw);
    },
    JSXAttribute(node) {
      const name = node.name.type === AST_NODE_TYPES.JSXNamespacedName ? node.name.name.name : node.name.name;
      const element = node.parent.name;
      const intrinsic = element.type === AST_NODE_TYPES.JSXIdentifier && /^[a-z]/.test(element.name);
      if (name === "style" || (intrinsic && SVG_COLOUR_ATTRIBUTES.has(name))) checkStyle(node.value, node);
    },
    VariableDeclarator(node) {
      if (isStyleType(node.id.typeAnnotation?.typeAnnotation)) checkStyle(node.init, node);
    },
    "TSAsExpression, TSSatisfiesExpression"(node: TSESTree.TSAsExpression | TSESTree.TSSatisfiesExpression) {
      if (isStyleType(node.typeAnnotation)) checkStyle(node.expression, node);
    },
    AssignmentExpression(node) {
      if (node.left.type === AST_NODE_TYPES.MemberExpression && isStyleMember(node.left.object)) checkStyle(node.right, node);
    },
    CallExpression(node) {
      const callee = node.callee;
      const setsProperty =
        callee.type === AST_NODE_TYPES.MemberExpression &&
        isStyleMember(callee.object) &&
        callee.property.type === AST_NODE_TYPES.Identifier &&
        callee.property.name === "setProperty";
      if (setsProperty) checkStyle(node.arguments[1], node);
    },
  };
};

// Stylesheets, as ESLint's CSS language parses them: a stylesheet file, and a document's `<style>` element.

type CssNode = CSSSyntaxElement;

/** Where a stylesheet node's colours stand and what they are: a declaration's value's, an `@apply`'s classes; any other node holds none. */
const stylesheetColours = (node: CssNode, text: (node: CssNode) => string): { at: CssNode; found: Found[] } | undefined => {
  if (node.type === "Declaration") return { at: node.value, found: valueColours(text(node.value)) };
  if (node.type === "Atrule" && node.name.toLowerCase() === "apply" && node.prelude) return { at: node.prelude, found: classStringColours(text(node.prelude)) };
  return undefined;
};

const isStylesheet = (sourceCode: unknown): sourceCode is CSSSourceCode =>
  (sourceCode as { ast: { type: string } }).ast.type === "StyleSheet";

const stylesheetVisitors = (context: Context, sourceCode: CSSSourceCode): TSESLint.RuleListener => {
  const check = (node: CssNode) => {
    const colours = stylesheetColours(node, (n) => sourceCode.getText(n));
    // typescript-eslint types a report's node as a script's; ESLint takes a stylesheet's the same way.
    const at = colours?.at as unknown as TSESTree.Node;
    for (const { colour, messageId } of colours?.found ?? []) context.report({ node: at, messageId, data: { colour } });
  };
  return { Declaration: check, Atrule: check };
};

/** ESLint's CSS language, which reads a document's `<style>` element as the configuration reads a stylesheet file: tolerantly. */
const cssLanguage = new CSSLanguage();

/** A CDATA section's markers, in which an SVG file may wrap a `<style>` element's stylesheet. */
const CDATA_MARKER = /<!\[CDATA\[|\]\]>/g;

/** A stylesheet's every node, through the CSS language's visitor keys. */
const nodesOf = (node: CssNode): CssNode[] => [
  node,
  ...(cssLanguage.visitorKeys[node.type] ?? []).flatMap((key) => {
    const child = (node as unknown as Record<string, CssNode | CssNode[] | null | undefined>)[key];
    return (Array.isArray(child) ? child : child ? [child] : []).flatMap(nodesOf);
  }),
];

/** The colours of a `<style>` element's stylesheet, its CDATA markers blanked, each with its offsets in the stylesheet. */
const styleElementColours = (stylesheet: string): { start: number; end: number; found: Found[] }[] => {
  const text = blank(stylesheet, CDATA_MARKER);
  const parsed = cssLanguage.parse({ path: "style.css", physicalPath: "style.css", body: text, bom: false }, { languageOptions: { tolerant: true } });
  if (!parsed.ok) return [];
  // The language parses with positions, so every node has its place; a node without one holds no text.
  const textOf = (node: CssNode) => (node.loc ? text.slice(node.loc.start.offset, node.loc.end.offset) : "");
  return nodesOf(parsed.ast).flatMap((node) => {
    const colours = stylesheetColours(node, textOf);
    const loc = colours?.at.loc;
    return colours && loc ? [{ start: loc.start.offset, end: loc.end.offset, found: colours.found }] : [];
  });
};

// SVG assets and HTML documents, as html-eslint's HTML language parses them.

/** An element as the HTML language parses one (a `Tag`, `StyleTag` or `ScriptTag`): its name, lower-cased, and its attributes. */
interface MarkupElement {
  readonly name?: string;
  readonly attributes: readonly MarkupAttribute[];
}
/** An attribute: its key as written, and its value as written, which a bare attribute (`disabled`) has none of. */
interface MarkupAttribute {
  readonly key: { readonly value: string };
  readonly value?: { readonly value: string };
}
/** A `<style>` element: its attributes, and its content with where the content starts in the file. */
interface StyleElement extends MarkupElement {
  readonly value?: { readonly value: string; readonly range: readonly [number, number] };
}

/** Whether an HTML document or an SVG file, which the HTML language parses into a program holding one `Document`. */
const isMarkup = (sourceCode: unknown): boolean =>
  (sourceCode as { ast: { body?: readonly { type: string }[] } }).ast.body?.[0]?.type === "Document";

/** Whether an element is `<meta name="theme-color">`, whose `content` colours the browser's frame before the theme is applied. */
const isThemeColourMeta = (element: MarkupElement): boolean =>
  element.name === "meta" &&
  element.attributes.some((a) => a.key.value.toLowerCase() === "name" && a.value?.value.trim().toLowerCase() === "theme-color");

/** Whether an attribute's value is a style: a `style` attribute, an SVG colour attribute, or the theme-color meta's `content`. */
const isStyleAttribute = (element: MarkupElement, key: string): boolean =>
  key === "style" || SVG_COLOUR_ATTRIBUTES.has(key) || (key === "content" && isThemeColourMeta(element));

/**
 * A document's checks: every attribute's value read as a script's every string is, the named colours of the ones that
 * are a style, and each `<style>` element as a stylesheet. Text, comments and an inline `<script>`'s body are not read.
 */
const markupVisitors = (context: Context): TSESLint.RuleListener => {
  // typescript-eslint types a report's node as a script's; ESLint takes a document's the same way.
  const report = (node: object, { colour, messageId }: Found) => context.report({ node: node as TSESTree.Node, messageId, data: { colour } });
  const checkAttributes = (element: MarkupElement) => {
    for (const { key, value } of element.attributes) {
      if (!value) continue;
      for (const found of classStringColours(value.value)) report(value, found);
      if (!isStyleAttribute(element, key.value.toLowerCase())) continue;
      for (const found of valueColours(value.value)) if (found.messageId === "named") report(value, found);
    }
  };
  const checkStyleElement = (element: StyleElement) => {
    checkAttributes(element);
    if (!element.value) return;
    const offset = element.value.range[0];
    const locAt = (index: number) => context.sourceCode.getLocFromIndex(offset + index);
    for (const { start, end, found } of styleElementColours(element.value.value)) {
      for (const { colour, messageId } of found) context.report({ loc: { start: locAt(start), end: locAt(end) }, messageId, data: { colour } });
    }
  };
  return { Tag: checkAttributes, StyleTag: checkStyleElement, ScriptTag: checkAttributes };
};

export const rule = createRule<[], MessageId>({
  name: "no-literal-colour",
  meta: {
    type: "problem",
    docs: { description: "A renderer package paints every colour with a token, never a literal colour (ADR 0023)." },
    schema: [],
    messages: {
      literal:
        "'{{colour}}' is a literal colour. Every colour a renderer paints is a token (ADR 0023): name it with var(--token), or currentColor.",
      tailwind:
        "'{{colour}}' is a Tailwind colour outside the theme. Every colour a renderer paints is a token (ADR 0023): use the token's class (bg-beam, text-ink) or bg-(--token).",
      named:
        "'{{colour}}' is a named colour in a style. Every colour a renderer paints is a token (ADR 0023): name it with var(--token), or currentColor, transparent or inherit.",
    },
  },
  defaultOptions: [],
  create(context) {
    if (isStylesheet(context.sourceCode)) return stylesheetVisitors(context, context.sourceCode);
    if (isMarkup(context.sourceCode)) return markupVisitors(context);
    return scriptVisitors(context);
  },
});
