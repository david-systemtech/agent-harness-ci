import { DOCUMENT_KIND_WORDS, documentWritten, type ToolCallEntry } from "@agent-harness/client-runtime";
import { usePaneDocuments } from "../session/pane-documents.js";
import { usePaneLine } from "../session/pane-line.js";
import { paneCapability } from "../side-column/panes.js";
import { Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/**
 * The document tiles under a run's calls (docs/specs/gui.md, "A session
 * pane": images and document tiles; #410): one for each page, SVG or
 * markdown file the calls wrote (`documentWritten`), in the order each was
 * first written, however many of them wrote it. A tile opens its document
 * in the Preview; while the Preview cannot draw (no shell's `preview`, or no
 * `files.read`) it is dim with the capability's line, and a press on it
 * says why in the pane's line.
 */
export const DocumentTiles = ({ calls, workspace }: { readonly calls: readonly ToolCallEntry[]; readonly workspace: string | null }) => {
  const runtime = useRuntime();
  const { session, preview } = usePaneDocuments();
  const [, say] = usePaneLine();
  if (workspace === null) return null;
  const written = new Map<string, string>();
  for (const call of calls) {
    const document = documentWritten(call, workspace);
    if (document !== null && !written.has(document.path)) written.set(document.path, DOCUMENT_KIND_WORDS[document.kind]);
  }
  if (written.size === 0) return null;
  const offer = paneCapability(runtime, session.environmentId, "preview");
  const absent = offer.status === "absent" ? offer.message : undefined;
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...written].map(([path, kind]) => (
        <Tooltip
          key={path}
          content={
            <>
              <span className="block">Shows it in the Preview, read as it is now.</span>
              {absent !== undefined && <span className="block text-ink-muted">{absent}</span>}
            </>
          }
        >
          <button
            type="button"
            aria-label={`Preview ${path}`}
            aria-disabled={absent === undefined ? undefined : true}
            className="flex min-w-0 flex-col items-start rounded-md border border-hairline px-2.5 py-1.5 text-left text-[0.85em] outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
            onClick={() => (absent === undefined ? preview(path) : say(`Not previewed: ${absent}`))}
          >
            <span className={absent === undefined ? "truncate font-mono text-ink" : "truncate font-mono text-ink-faint"}>{path}</span>
            <span className="text-ink-muted">{kind}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
};
