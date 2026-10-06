import { createContext, memo, use, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { FindQuery, findMarks, Marked } from "./find.js";

/**
 * Markdown as the transcript draws it (docs/specs/gui.md, "A session pane"):
 * GitHub's flavour (tables, task lists, strikethrough, links written bare),
 * a fenced block's code highlighted by the language its fence names (never
 * guessed: a wrong guess reads worse than plain text), in the theme's tokens
 * (`styles.css`). Raw HTML in the text is shown as text, never rendered. An
 * image is drawn from the text itself (a `data:` URL of a picture); one
 * elsewhere is a link to it, never fetched on its own, or inside a link its
 * words alone. The find bar's query is marked where it matches (`find.tsx`).
 * Text still streaming is drawn by the same parse, so a reply reads the same
 * while it arrives and once it has settled; the streaming fade adds a plugin
 * of its own and the elements it makes (`streaming-text.tsx`).
 */

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
/** A plugin over the tree markdown is drawn from (hast). */
export type RehypePlugin = NonNullable<Options["rehypePlugins"]>[number];

const HIGHLIGHT: RehypePlugin = [rehypeHighlight, { detect: false }];

/** The pictures the window draws from the text itself: the image types a provider takes. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** A URL as the text may carry it: a `data:` picture for an image's source, else what react-markdown keeps (http, https, mailto and the like). */
const urlTransform: Options["urlTransform"] = (url, key) => (key === "src" && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url));

/** Whether what is drawn sits inside a link: a picture there is named by its words, never a second link. */
const InLink = createContext(false);

const Image = ({ src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) => {
  const inLink = use(InLink);
  if (typeof src === "string" && DATA_IMAGE.test(src)) return <img src={src} alt={alt ?? ""} className="max-h-96 max-w-full rounded-md border border-hairline object-contain" />;
  const words = alt === undefined || alt === "" ? (typeof src === "string" ? src : "") : alt;
  if (inLink || typeof src !== "string" || src === "") return <span>{words}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      {words}
    </a>
  );
};

const Link = ({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) => (
  <a href={href} target="_blank" rel="noreferrer">
    <InLink value>{children}</InLink>
  </a>
);

const COMPONENTS: Components = { img: Image, a: Link };

export interface MarkdownProps {
  readonly text: string;
  /** A rehype plugin run after the others, and the components drawing the elements it makes. */
  readonly plugin?: RehypePlugin | undefined;
  readonly components?: Components | undefined;
}

/** Markdown with what the find bar looks for marked, parsed again only when its text, the query or the plugin changes. */
export const Markdown = ({ text, plugin, components }: MarkdownProps) => {
  const query = use(FindQuery);
  // Bound Markdown parsing for very long provider output without dropping its searchable text.
  return text.length > 80_000 ? <div className="whitespace-pre-wrap break-words"><Marked text={text} /></div> : <Parsed text={text} query={query} plugin={plugin} components={components} />;
};

const Parsed = memo(({ text, query, plugin, components }: MarkdownProps & { readonly query: string }) => {
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(
    () => [HIGHLIGHT, ...(query === "" ? [] : [findMarks(query)]), ...(plugin === undefined ? [] : [plugin])],
    [query, plugin],
  );
  const drawn = useMemo(() => (components === undefined ? COMPONENTS : { ...COMPONENTS, ...components }), [components]);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={drawn} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
