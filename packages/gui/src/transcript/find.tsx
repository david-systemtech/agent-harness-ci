import { createContext, use, type ReactNode } from "react";

/**
 * What the find bar looks for, and how the transcript marks it
 * (docs/specs/gui.md, "A session pane": a find bar, Mod+F). Every text the
 * transcript draws is drawn through `Marked` (or, as markdown, through the
 * `findMarks` plugin), which marks each match of the query, ignoring case,
 * with `<mark>`; the bar counts the marks drawn and walks them in the order
 * they are drawn. So what the find bar finds is what the transcript shows:
 * a fold's calls are found once it is unfolded.
 */

/** The find bar's query, trimmed; empty while the bar is closed or nothing is typed. */
export const FindQuery = createContext("");

/** `text` cut at each match of `query`, ignoring case: the pieces between, and the matches. */
export const matchesIn = (text: string, query: string): readonly { readonly text: string; readonly match: boolean }[] => {
  if (query === "") return [{ text, match: false }];
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  const pieces: { text: string; match: boolean }[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + needle.length)) {
    if (at > from) pieces.push({ text: text.slice(from, at), match: false });
    pieces.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) pieces.push({ text: text.slice(from), match: false });
  return pieces;
};

/** Text, with each match of the find bar's query marked. */
export const Marked = ({ text }: { readonly text: string }): ReactNode => {
  const query = use(FindQuery);
  if (query === "") return text;
  return matchesIn(text, query).map((piece, index) => (piece.match ? <mark key={index}>{piece.text}</mark> : piece.text));
};

/** A node of the tree markdown is rendered from (hast), as much of it as the marking reads. */
interface TreeNode {
  readonly type: string;
  readonly tagName?: string;
  readonly value?: string;
  children?: TreeNode[];
}

const markText = (node: TreeNode, query: string): void => {
  if (node.children === undefined || node.tagName === "mark") return;
  node.children = node.children.flatMap((child): TreeNode[] => {
    if (child.type !== "text" || child.value === undefined) {
      markText(child, query);
      return [child];
    }
    return matchesIn(child.value, query).map((piece) =>
      piece.match ? { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: piece.text }] } : { type: "text", value: piece.text },
    ) as TreeNode[];
  });
};

/** A rehype plugin marking each match of `query` in rendered markdown, code included. */
export const findMarks =
  (query: string) =>
  () =>
  (tree: unknown): void =>
    markText(tree as TreeNode, query);
