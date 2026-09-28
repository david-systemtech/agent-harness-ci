import { memo, useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { findMarks } from "./find.js";

/**
 * Markdown as the transcript draws it (docs/specs/gui.md, "A session pane"):
 * GitHub's flavour (tables, task lists, strikethrough, links written bare),
 * a fenced block's code highlighted by the language its fence names (never
 * guessed: a wrong guess reads worse than plain text), in the theme's tokens
 * (`styles.css`). Raw HTML in the text is shown as text, never rendered. An
 * image is drawn from the text itself (a `data:` URL of a picture); one
 * elsewhere is a link to it, never fetched on its own. The find bar's
 * query is marked where it matches (`find.tsx`).
 */

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
const HIGHLIGHT: NonNullable<Options["rehypePlugins"]>[number] = [rehypeHighlight, { detect: false }];

/** The pictures the window draws from the text itself: the image types a provider takes. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

/** A URL as the text may carry it: a `data:` picture for an image's source, else what react-markdown keeps (http, https, mailto and the like). */
const urlTransform: Options["urlTransform"] = (url, key) => (key === "src" && DATA_IMAGE.test(url) ? url : defaultUrlTransform(url));

const Image = ({ src, alt }: ComponentPropsWithoutRef<"img"> & ExtraProps) => {
  if (typeof src === "string" && DATA_IMAGE.test(src)) return <img src={src} alt={alt ?? ""} className="max-h-96 max-w-full rounded-md border border-hairline object-contain" />;
  if (typeof src !== "string" || src === "") return <span>{alt}</span>;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      {alt === undefined || alt === "" ? src : alt}
    </a>
  );
};

const Link = ({ href, children }: ComponentPropsWithoutRef<"a"> & ExtraProps) => (
  <a href={href} target="_blank" rel="noreferrer">
    {children}
  </a>
);

const COMPONENTS: Components = { img: Image, a: Link };

export interface MarkdownProps {
  readonly text: string;
  /** What the find bar looks for, marked where it matches; empty for nothing. */
  readonly query?: string;
}

/** Markdown, parsed again only when its text or the find bar's query changes. */
export const Markdown = memo(({ text, query = "" }: MarkdownProps) => {
  const rehypePlugins = useMemo<Options["rehypePlugins"]>(() => (query === "" ? [HIGHLIGHT] : [HIGHLIGHT, findMarks(query)]), [query]);
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={COMPONENTS} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
