import { NO_DOCUMENTS, documentFacts } from "@agent-harness/client-runtime";
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
  if (documents.length === 0) return <p className="px-3 py-2 text-sm text-ink-faint">{NO_DOCUMENTS}</p>;
  const now = clock.now();
  return (
    <ul aria-label="The session's documents" className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-2">
      {documents.map((document) => (
        <li key={document.path}>
          <article aria-label={document.path} className="flex flex-col gap-1 rounded-md border border-hairline px-2.5 py-1.5 text-xs">
            <p className="truncate font-mono text-ink">{document.path}</p>
            <p className="text-ink-muted">{documentFacts(document, now).join(" · ")}</p>
            <div className="flex items-center gap-1">
              <VerbButton
                does="Shows it in the Preview, read as it is now."
                availability={previewOffer}
                run={() => (previewOffer.status === "absent" ? say(`Not previewed: ${previewOffer.message}`) : preview(document.path))}
              >
                Preview
              </VerbButton>
              <VerbButton
                does="Opens its text in the Files pane."
                availability={sourceOffer}
                run={() => (sourceOffer.status === "absent" ? say(`Not opened: ${sourceOffer.message}`) : source(document.path))}
              >
                Source
              </VerbButton>
              <VerbButton does="Shows the call that first wrote it in the transcript." availability={{ status: "present" }} run={() => reveal(document.first.toolCallId)}>
                Transcript
              </VerbButton>
            </div>
          </article>
        </li>
      ))}
    </ul>
  );
};
