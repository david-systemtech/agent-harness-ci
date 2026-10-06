import { NO_DOCUMENTS, documentFacts } from "@agent-harness/client-runtime";
import { Eye, FileCode, FileImage, FileText, MessageSquare, SquareArrowOutUpRight } from "lucide-react";
import { useMemo } from "react";
import { usePaneDocuments } from "../session/pane-documents.js";
import { usePaneLine } from "../session/pane-line.js";
import { VerbButton } from "../session/verb-button.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { paneCapability } from "./panes.js";

/**
 * The Documents pane (docs/specs/gui.md, "The seven panes and the grid";
 * #410): the pages, SVGs and markdown the session wrote
 * (`projections.documents`), most recently touched first, each with its
 * kind, its size when last written whole, how many calls wrote it and when
 * the last one's turn started. Each opens the Preview, its source in the
 * Files pane's file view, or the transcript at the call that first wrote
 * it. It lists what the runtime holds, so it is never dim; Preview and
 * Source are, with the capability's line, while the Preview or the Files
 * pane cannot draw, and a press on one then says why in the pane's line.
 */

export interface DocumentsPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** Opens `path` in the Files pane's file view. */
  source(path: string): void;
}

export const DocumentsPane = ({ environmentId, sessionId, source }: DocumentsPaneProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  // The connections' phases: Preview and Source are asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const documents = useObservable(useMemo(() => runtime.projections.documents(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const { preview, reveal } = usePaneDocuments();
  const [, say] = usePaneLine();
  const previewOffer = paneCapability(runtime, environmentId, "preview");
  const sourceOffer = paneCapability(runtime, environmentId, "files");
  if (documents.length === 0) return <p className="p-1.5 text-sm text-ink-faint">{NO_DOCUMENTS}</p>;
  const now = clock.now();
  return (
    <ul aria-label="The session's documents" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
      {documents.map((document) => (
        <li key={document.path}>
          <article aria-label={document.path} className="group flex items-start gap-2 rounded-md border border-hairline bg-wash-strong px-2 py-1.5 text-xs">
            <span data-document-glyph className="flex size-6 shrink-0 items-center justify-center rounded-md border border-hairline bg-wash-strong text-ink-muted">
              {document.kind === "svg" ? <FileImage aria-hidden="true" className="size-3.5" /> : document.kind === "markdown" ? <FileText aria-hidden="true" className="size-3.5" /> : <FileCode aria-hidden="true" className="size-3.5" />}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="truncate font-medium text-ink" title={document.path}>{document.path}</p>
              <p className="text-2xs text-ink-muted">{documentFacts(document, now).join(" · ")}</p>
              <div data-document-actions className="flex flex-wrap items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <VerbButton
                  does="Shows it in the Preview, read as it is now." keys="Enter or Space"
                  availability={previewOffer}
                  run={() => (previewOffer.status === "absent" ? say(`Not previewed: ${previewOffer.message}`) : preview(document.path))}
                >
                  <Eye aria-hidden="true" />Preview
                </VerbButton>
                <VerbButton
                  does="Opens its text in the Files pane." keys="Enter or Space"
                  availability={sourceOffer}
                  run={() => (sourceOffer.status === "absent" ? say(`Not opened: ${sourceOffer.message}`) : source(document.path))}
                >
                  <SquareArrowOutUpRight aria-hidden="true" />Source
                </VerbButton>
                <VerbButton does="Shows the call that first wrote it in the transcript." keys="Enter or Space" availability={{ status: "present" }} run={() => reveal(document.first.toolCallId)}>
                  <MessageSquare aria-hidden="true" />Transcript
                </VerbButton>
              </div>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
};
