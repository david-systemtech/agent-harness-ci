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

/** look.md §8.2: bound DOM work even when a small file has many lines. */
export const FILE_DISPLAY_LINES = 20_000;
export const fileLineCount = (text: string): number => text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

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
  const count = fileLineCount(text);
  const clipped = count > FILE_DISPLAY_LINES;
  const displayed = clipped ? text.split("\n").slice(0, FILE_DISPLAY_LINES).join("\n") : text;
  const drawn = useMemo(() => {
    const language = languageOf(path);
    return language === undefined || displayed.length > HIGHLIGHT_MOST ? displayed : draw(lowlight.highlight(language, displayed).children);
  }, [path, displayed]);
  return <>
    {clipped && <p className="shrink-0 px-3 py-1 font-mono text-2xs text-amber">Only the first 20,000 lines are shown.</p>}
    <div data-file-code className="min-h-0 min-w-0 flex-1 overflow-auto py-[4px]">
      <pre className="flex min-w-max gap-[12px] px-[12px] font-mono text-[11px] leading-relaxed text-ink">
        <span aria-label="Line numbers" className="w-[40px] shrink-0 select-none text-right text-ink-faint" data-file-gutter>
          {Array.from({ length: Math.min(count, FILE_DISPLAY_LINES) }, (_, index) => <span key={index} className="block">{index + 1}</span>)}
        </span>
        <code>{drawn}</code>
      </pre>
    </div>
  </>;
};
