import { common, createLowlight } from "lowlight";
import { useMemo, type ReactNode } from "react";

/**
 * A file's text highlighted as the transcript's code is (docs/specs/gui.md,
 * "The seven panes and the grid": the file view), in the theme's tokens
 * through the highlighter's classes (`styles.css`): the language its name
 * says (its extension, else its whole name, as a Makefile's), never guessed
 * from its text, and plain where the highlighter knows no such language.
 */

const lowlight = createLowlight(common);

/** Past this many characters a file is drawn plain: highlighting runs on the window's thread (a chosen default). */
const HIGHLIGHT_MOST = 512 * 1024;

type Tree = ReturnType<typeof lowlight.highlight>;
type Node = Tree["children"][number];

/** The language the file at `path` is in, as the highlighter names one; undefined when its name says none it knows. */
export const languageOf = (path: string): string | undefined => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  const said = dot > 0 ? name.slice(dot + 1) : name;
  return lowlight.registered(said) ? said : undefined;
};

const classNameOf = (value: unknown): string | undefined => (Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : undefined);

const draw = (nodes: readonly Node[]): ReactNode[] =>
  nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type !== "element") return null;
    return (
      <span key={index} className={classNameOf(node.properties["className"])}>
        {draw(node.children)}
      </span>
    );
  });

/** `text`, the file at `path`'s, drawn in a monospaced block, highlighted when its name says a language. */
export const Highlighted = ({ path, text }: { readonly path: string; readonly text: string }) => {
  const drawn = useMemo(() => {
    const language = languageOf(path);
    return language === undefined || text.length > HIGHLIGHT_MOST ? text : draw(lowlight.highlight(language, text).children);
  }, [path, text]);
  return (
    <pre className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs text-ink">
      <code>{drawn}</code>
    </pre>
  );
};
