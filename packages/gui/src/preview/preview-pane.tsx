import { binaryNote, clockTime, documentKindOf, fileMarks, type DocumentKind } from "@agent-harness/client-runtime";
import { Download, FileCode } from "lucide-react";
import { FILES_READ_CAP } from "@agent-harness/contracts";
import { useEffect, useState } from "react";
import { webPreview } from "../platform/web-preview.js";
import { Button, Tooltip } from "../ui/index.js";
import { usePaneDocuments, type Previewed } from "../session/pane-documents.js";
import { Markdown } from "../transcript/markdown.js";
import { useClock, useRuntime, useShell } from "../window-context.js";
import { PREVIEW_FRAME_CANVAS } from "./preview-frame-content.js";

/**
 * The Preview pane (docs/specs/gui.md, "The seven panes and the grid";
 * #410): the document the Documents pane or a transcript's document tile
 * opened, read through `files.read`. A page or an SVG is framed from the URL
 * the shell's `preview.grant` answers for its bytes (the desktop serves them
 * from memory on `agent-harness-preview:`, with no network), in a frame
 * sandboxed with scripts and without same-origin, so its script runs in an
 * opaque origin with no reach into the window; markdown is drawn in the
 * window, as the transcript draws it, never framed. It is a snapshot: what
 * the run writes afterwards is not shown until the document is opened
 * again, which reads it again, as does the pane opened afresh. The side
 * column requires `files.read`. Without a desktop preview grant, HTML/SVG
 * are static srcdoc snapshots: scripts, forms, navigation and network are disabled.
 */

export interface PreviewPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
  source(path: string): void;
}

/** The media type a framed document is granted with: the text `files.read` answers, as UTF-8. */
const MEDIA_TYPES: Readonly<Record<Exclude<DocumentKind, "markdown">, string>> = { page: "text/html; charset=utf-8", svg: "image/svg+xml" };

/** What one opening of a document came to. */
type Shown =
  | { readonly state: "reading" }
  | { readonly state: "said"; readonly words: string }
  | { readonly state: "framed"; readonly url: string; readonly marks: string; readonly at: string }
  | { readonly state: "static"; readonly text: string; readonly snapshot: string; readonly marks: string; readonly at: string }
  | { readonly state: "markdown"; readonly text: string; readonly marks: string; readonly at: string };

export const PreviewPane = ({ environmentId, sessionId, source }: PreviewPaneProps) => {
  const { previewed } = usePaneDocuments();
  if (previewed === null) return <p className="px-3 py-2 text-sm text-ink-faint">Nothing to preview: choose a page, an SVG or a markdown file in Documents.</p>;
  return <Opened key={previewed.opening} environmentId={environmentId} sessionId={sessionId} source={source} previewed={previewed} />;
};

/** One opening of a document: read once, as it stands now. */
const Opened = ({ environmentId, sessionId, previewed, source }: PreviewPaneProps & { readonly previewed: Previewed }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const clock = useClock();
  const [shown, show] = useState<Shown>({ state: "reading" });
  const { path } = previewed;
  useEffect(() => {
    let current = true;
    const say = (words: string) => {
      if (current) show({ state: "said", words });
    };
    void (async () => {
      const kind = documentKindOf(path);
      if (kind === null) return say(`Not previewed: ${path} is no page, SVG or markdown file.`);
      const answer = await runtime.requests.call(environmentId, "files.read", { sessionId, path });
      if (!current) return;
      if (!answer.ok) return say(`Not read: ${answer.error.message}`);
      const { text } = answer.result;
      if (answer.result.binary || text === null) return say(binaryNote(answer.result.size));
      if (answer.result.truncated) return say(`Not previewed: ${path} is larger than the ${String(FILES_READ_CAP / (1024 * 1024))} MiB the environment reads of a file.`);
      const marks = fileMarks(answer.result).join(" · ");
      const at = clockTime(clock.now().toISOString());
      if (kind === "markdown") return show({ state: "markdown", text, marks, at });
      if (shell?.preview === undefined) return show({ state: "static", text, snapshot: webPreview(text), marks, at });
      try {
        const url = await shell.preview.grant({ bytes: new TextEncoder().encode(text), mediaType: MEDIA_TYPES[kind] });
        if (current) show({ state: "framed", url, marks, at });
      } catch (error) {
        say(`Not previewed: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
    return () => {
      current = false;
    };
  }, [runtime, shell, clock, environmentId, sessionId, path]);

  if (shown.state === "reading") return <p className="px-3 py-2 text-sm text-ink-faint">Reading…</p>;
  if (shown.state === "said") return <p className="px-3 py-2 text-sm text-ink-faint">{shown.words}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h3 className="shrink-0 truncate px-3 pt-2 pb-1 font-mono text-xs text-ink">
        <span className="font-semibold">{path}</span>
        {" · "}
        <span className="text-ink-muted">{`${shown.marks} · read at ${shown.at}`}</span>
      </h3>
      {shown.state === "static" && <div className="shrink-0 border-b border-hairline px-3 py-2 text-xs text-ink-muted">
        <p>Static preview. Preview scripts require the desktop client; forms and network are disabled here.</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Tooltip content="Open the document's source" keys="Enter / Space"><Button size="xs" onClick={() => source(path)}><FileCode aria-hidden="true" />Source</Button></Tooltip>
          <Tooltip content="Download this snapshot's source" keys="Enter / Space"><a className="inline-flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-md px-2 text-xs text-ink-muted hover:bg-raised focus-visible:outline-2 focus-visible:outline-beam" href={`data:text/plain;charset=utf-8,${encodeURIComponent(shown.text)}`} download={path.split("/").at(-1)}><Download aria-hidden="true" className="size-3" />Download</a></Tooltip>
        </div>
      </div>}
      {shown.state === "markdown" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-ink">
          <div className="mx-auto max-w-[48rem]" data-preview-markdown><Markdown text={shown.text} /></div>
        </div>
      ) : (
        <iframe
          title={`Preview of ${path}`}
          {...(shown.state === "static" ? { srcDoc: shown.snapshot } : { src: shown.url })}
          // Browser snapshots grant nothing; desktop scripts never receive same-origin.
          sandbox={shown.state === "static" ? "" : "allow-scripts"}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0"
          style={{ background: PREVIEW_FRAME_CANVAS }}
        />
      )}
    </div>
  );
};
