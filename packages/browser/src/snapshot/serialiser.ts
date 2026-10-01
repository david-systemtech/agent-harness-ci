import { SNAPSHOT_MAX_CHARS, type PageArgs } from "@agent-harness/contracts";
import { redactTokens, redactedFieldValue, secretField } from "../redaction.js";
import { refGone } from "./refs.js";
import { renderAriaSnapshotAsYaml } from "./vendor/aria-yaml.js";
import type { AriaNodeJSON } from "./vendor/aria-types.js";

/**
 * The snapshot's serialiser (browser spec, "The tools" and "Model-boundary
 * hygiene"): from the element tree the page answered, its frames stitched
 * in, to the text the model reads, one element a line as Playwright writes
 * it for a model. It focuses on the element a ref names, keeps the elements
 * the filter asks for and the levels depth asks for, redacts what the model
 * may never read, writes the tree, and cuts the text to its budget.
 */

/** A snapshot's text, or the sentence that says why there is none. */
export type SerialisedSnapshot =
  | { readonly ok: true; readonly text: string; readonly totalChars: number; readonly truncated: boolean }
  | { readonly ok: false; readonly reason: string };

type Child = AriaNodeJSON | string;

/** The roles of the elements that take input: what `interactive` keeps, beside an element whose cursor says it is clicked. */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "scrollbar",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** The roles that say where an element sits, kept around what `interactive` keeps though they have no name: landmarks, dialogs, and frames. */
const CONTEXT_ROLES: ReadonlySet<string> = new Set([
  "alertdialog",
  "banner",
  "complementary",
  "contentinfo",
  "dialog",
  "form",
  "iframe",
  "main",
  "navigation",
  "region",
  "search",
]);

const childrenOf = (node: AriaNodeJSON): readonly Child[] => node.children ?? (node.text === undefined ? [] : [node.text]);

/** `node` with `children` in place of its own, written as the in-page snapshot writes one: a lone string as its text. */
const withChildren = (node: AriaNodeJSON, children: readonly Child[]): AriaNodeJSON => {
  const rest: AriaNodeJSON = { ...node };
  delete rest.children;
  delete rest.text;
  const [only] = children;
  if (children.length === 1 && typeof only === "string") return { ...rest, text: only };
  return children.length === 0 ? rest : { ...rest, children: [...children] };
};

/** An element that can be acted on: one with a ref whose role takes input, or whose cursor says a click does something. */
const actionable = (node: AriaNodeJSON): boolean => node.ref !== undefined && (INTERACTIVE_ROLES.has(node.role) || node.cursor === "pointer");

/**
 * The elements that can be acted on, each whole, under the ancestors that
 * say where they are (a name, a landmark, a dialog, a frame); an ancestor
 * with neither gives its place to what it holds, and an element with
 * nothing to act on in it is left out, its text with it.
 */
const interactive = (children: readonly Child[]): AriaNodeJSON[] =>
  children.flatMap((child): AriaNodeJSON[] => {
    if (typeof child === "string") return [];
    if (actionable(child)) return [child];
    const kept = interactive(childrenOf(child));
    if (kept.length === 0) return [];
    return child.name !== undefined || CONTEXT_ROLES.has(child.role) ? [withChildren(child, kept)] : kept;
  });

/** The tree cut below `depth` levels: an element at the last level keeps only text of its own, as Playwright's depth does. */
const toDepth = (nodes: readonly Child[], depth: number): Child[] =>
  nodes.map((node) => {
    if (typeof node === "string") return node;
    if (depth > 1) return withChildren(node, toDepth(childrenOf(node), depth - 1));
    return node.text === undefined ? withChildren(node, []) : withChildren(node, [node.text]);
  });

/** The element of the tree with `ref`, in document order. */
const findRef = (nodes: readonly Child[], ref: string): AriaNodeJSON | undefined => {
  for (const node of nodes) {
    if (typeof node === "string") continue;
    if (node.ref === ref) return node;
    const found = findRef(childrenOf(node), ref);
    if (found) return found;
  }
  return undefined;
};

/**
 * What the model may read of the tree, whatever the page reported: a field
 * the rule names (a password, a card detail, a one-time code) shows its
 * marker alone, and every token-shaped string in a name, a text, an address
 * or a placeholder its own.
 */
const redacted = (node: Child): Child => {
  if (typeof node === "string") return redactTokens(node);
  const { name, url, placeholder } = node;
  const clean: AriaNodeJSON = {
    ...node,
    ...(name !== undefined && { name: redactTokens(name) }),
    ...(url !== undefined && { url: redactTokens(url) }),
    ...(placeholder !== undefined && { placeholder: redactTokens(placeholder) }),
  };
  const secret = node.field === undefined ? null : secretField(node.field);
  return withChildren(clean, secret === null ? childrenOf(node).map(redacted) : [redactedFieldValue(secret)]);
};

/**
 * `text` cut to its whole lines within `maxChars`, with its full length: when
 * the first line alone is longer, no line is whole within them and the text
 * is empty, so a cut is always at a line boundary, as the contract says.
 */
const withinBudget = (text: string, maxChars: number): { readonly text: string; readonly totalChars: number; readonly truncated: boolean } => {
  if (text.length <= maxChars) return { text, totalChars: text.length, truncated: false };
  const lineEnd = text.lastIndexOf("\n", maxChars);
  return { text: lineEnd === -1 ? "" : text.slice(0, lineEnd), totalChars: text.length, truncated: true };
};

/** The text of `tree` as `args` asks: focused on a ref, filtered, to a depth. */
export const serialiseSnapshot = (tree: readonly AriaNodeJSON[], args: PageArgs<"snapshot">): SerialisedSnapshot => {
  let roots: readonly AriaNodeJSON[] = tree;
  if (args.ref !== undefined) {
    const focused = findRef(tree, args.ref);
    if (!focused) {
      return {
        ok: false,
        reason: `${refGone(args.ref)} Take a new snapshot without ref, and focus on a ref it gives.`,
      };
    }
    roots = [focused];
  }
  // A focused element stands whatever the filter, and the filter reads below it.
  const filtered = (args.filter ?? "interactive") === "all" ? [...roots] : args.ref !== undefined ? roots.map((root) => (actionable(root) ? root : withChildren(root, interactive(childrenOf(root))))) : interactive(roots);
  let nodes: Child[] = filtered;
  if (args.depth !== undefined) nodes = toDepth(nodes, args.depth);
  const text = renderAriaSnapshotAsYaml(nodes.map(redacted).filter((node): node is AriaNodeJSON => typeof node !== "string"));
  return { ok: true, ...withinBudget(text, args.maxChars ?? SNAPSHOT_MAX_CHARS.preset) };
};
