import { NO_RUN_YET, runInfoFacts } from "@agent-harness/client-runtime";
import { Info } from "lucide-react";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useFirstKey, useIsKeyOf, useKeyAction } from "../keys/key-dispatch.js";
import { Dialog, DialogContent, IconButton } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

export interface RunInfoProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/** The latest run, grouped into the window's bounded, scrolling facts dialog (look.md §11.1). */
export const RunInfo = ({ environmentId, sessionId }: RunInfoProps) => {
  const [open, setOpen] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const keys = useFirstKey("app.runInfo.toggle");
  const toggles = useIsKeyOf("app.runInfo.toggle");
  useKeyAction("app.runInfo.toggle", () => setOpen((shown) => !shown));
  return <Dialog open={open} onOpenChange={setOpen}>
    <IconButton label="Run info" {...(keys !== undefined && { keys })} size="icon-xs" className="ml-auto" onClick={() => setOpen(true)}><Info aria-hidden="true" /></IconButton>
    {open && <DialogContent ref={content} aria-modal="true" onOpenAutoFocus={(event) => { event.preventDefault(); content.current?.focus(); }} title="Run info" data-measure="run-info" className="max-w-[32rem] max-h-[calc(100dvh-4rem)] gap-0 p-0 [&>div:first-child]:px-4 [&>div:first-child]:py-3" onKeyDown={(event) => { if (toggles(event)) { event.preventDefault(); setOpen(false); } }}>
      <LatestRun environmentId={environmentId} sessionId={sessionId} />
    </DialogContent>}
  </Dialog>;
};

const LatestRun = ({ environmentId, sessionId }: RunInfoProps) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const catalogues = useObservable(useMemo(() => runtime.projections.models(environmentId), [runtime, environmentId]));
  const run = projection.runs.at(-1);
  if (run === undefined) return <p className="px-4 pb-3 text-sm text-ink-faint">{NO_RUN_YET}</p>;
  const policy = projection.policies[run.runId];
  const account = accounts.value?.find((candidate) => candidate.id === run.accountId);
  const facts = runInfoFacts(run, policy, account, catalogues.value);
  const tools = projection.items.filter((item) => item.kind === "tool-call" && item.runId === run.runId);
  const groups = [
    { name: "Run", terms: ["Started by", "Model", "Effort", "Ending"] },
    { name: "Account", terms: ["Account"] },
    { name: "Usage", terms: ["Tokens", "Cost"] },
    { name: "Capabilities", terms: ["Mode", "Containment"] },
  ];
  return <section aria-label="The latest run" className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3">
    {groups.map(({ name, terms }) => <section key={name} aria-label={name} className="rounded-lg border border-hairline bg-inset/60 px-2 py-1.5">
      <h3 className="mb-1 text-sm font-semibold">{name}</h3>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {facts.filter(({ term }) => terms.includes(term)).map(({ term, words }) => <Fact key={term} term={term}>{words}</Fact>)}
      </dl>
    </section>)}
    <section aria-label="Tools" className="rounded-lg border border-hairline bg-inset/60 px-2 py-1.5">
      <h3 className="mb-1 text-sm font-semibold">Tools</h3>
      <p className="font-mono text-xs text-ink-muted">{tools.length === 0 ? "No tool calls reported for this run." : `${tools.length} tool calls reported for this run.`}</p>
    </section>
  </section>;
};

const Fact = ({ term, children }: { readonly term: string; readonly children: ReactNode }) => <>
  <dt className="text-ink-faint">{term}</dt>
  <dd className="min-w-0 break-words font-mono text-ink">{children}</dd>
</>;
