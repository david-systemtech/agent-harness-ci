import { DOCUMENT_KIND_WORDS, documentWritten, type ToolCallEntry } from "@agent-harness/client-runtime";
import { FileCode, FileImage, FileText } from "lucide-react";
import { usePaneDocuments } from "../session/pane-documents.js";
import { usePaneLine } from "../session/pane-line.js";
import { paneCapability } from "../side-column/panes.js";
import { Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/** A named document action, also used by the component gallery. */
export const DocumentTile = ({ path, kind, absent, preview }: { readonly path: string; readonly kind: string; readonly absent?: string | undefined; readonly preview: () => void }) => {
  const Icon = kind === DOCUMENT_KIND_WORDS["page"] ? FileCode : kind === DOCUMENT_KIND_WORDS["svg"] ? FileImage : FileText;
  const label = `Preview ${path} (Enter or Space)`;
  return <Tooltip content={<><span className="block">{label}: read as it is now.</span>{absent !== undefined && <span className="block text-ink-muted">{absent}</span>}</>}>
    <button type="button" aria-label={`Preview ${path}`} aria-disabled={absent === undefined ? undefined : true} title={label}
      className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-hairline-strong bg-wash px-2.5 py-2 text-left text-xs outline-none hover:bg-wash-strong focus-visible:outline-2 focus-visible:outline-beam aria-disabled:cursor-default aria-disabled:opacity-50 aria-disabled:hover:bg-wash"
      onClick={preview}>
      <Icon aria-hidden="true" className="size-4 shrink-0 text-cyan" />
      <span className="min-w-0"><span className="block truncate font-mono text-ink">{path}</span><span className="block text-2xs text-ink-muted">{kind}</span></span>
    </button>
  </Tooltip>;
};

/** One tile per written document; preview reachability and denial feedback stay with the pane. */
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
  return <div className="flex flex-wrap gap-1.5">
    {[...written].map(([path, kind]) => <DocumentTile key={path} path={path} kind={kind} absent={absent} preview={() => (absent === undefined ? preview(path) : say(`Not previewed: ${absent}`))} />)}
  </div>;
};
