import type { BankJoinPreview } from "@agent-harness/contracts";
import { Eye, Link, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button, Fold, Input } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { BankField, BankRefusal, useFieldCheck } from "./bank-controls.js";
import { bankRefusal } from "./bank-words.js";

/** setup-copy.md §5.8's line for a preview whose forge account cannot read the notebook. */
const CANNOT_READ = "Your forge account cannot read this notebook. Ask an owner to add you.";

export const JoinBankForm = ({ environmentId, busy, join }: {
  readonly environmentId: string;
  readonly busy: boolean;
  readonly join: (url: string, accounts: string[]) => Promise<void>;
}) => {
  const runtime = useRuntime();
  const [url, setUrl] = useState("");
  const [previewUrl, preview] = useState<string>();
  /** The accounts unticked; every account uses the notebook unless the person unticks it (setup-copy.md §5.8). */
  const [unticked, untick] = useState<readonly string[]>([]);
  const { missing, press, form } = useFieldCheck<"url">();
  const accounts = useObservable(useMemo(() => runtime.requests.cached(environmentId, "accounts.list", {}), [runtime, environmentId]));
  const read = useFollowed(useMemo(() => previewUrl === undefined ? undefined : runtime.requests.cached(environmentId, "banks.join.preview", { url: previewUrl }), [runtime, environmentId, previewUrl]));
  const result = read?.error === null ? read.result : null;
  const ticked = accounts.result?.accounts.filter((account) => !unticked.includes(account.id)).map((account) => account.id) ?? [];
  return <div ref={form} className="contents">
    <BankField wide icon={Link} label="Notebook link" error={missing.url}><Input value={url} onChange={(event) => { setUrl(event.target.value); preview(undefined); untick([]); }} /></BankField>
    <Button variant="outline" title="Preview · Tab, Enter or Space" className="self-start" disabled={busy || read?.loading === true} onClick={() => press({ url: [url, "a notebook link"] }, () => {
      const next = url.trim();
      preview(next);
      runtime.requests.refresh(environmentId, "banks.join.preview", { url: next });
    })}><Eye aria-hidden="true" />Preview</Button>
    {read?.loading === true && read.result === null && <p role="status" className="text-xs text-ink-muted">Reading the notebook…</p>}
    {read?.error != null && <BankRefusal refusal={bankRefusal(read.error, "Preview")} />}
    {result != null && <>
      <JoinPreview preview={result} />
      {result.canRead ? <>
        <div role="group" aria-label="Which of your accounts should use it?" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
          <h4 className="text-xs font-medium">Which of your accounts should use it?</h4>
          {accounts.result?.accounts.map((account) => <label key={account.id} className="flex items-center gap-2 text-xs">
            <input type="checkbox" title={`${account.label} · Tab, Space`} checked={!unticked.includes(account.id)} onChange={(event) => untick((held) => event.target.checked ? held.filter((id) => id !== account.id) : [...held, account.id])} />
            {account.label}
          </label>)}
        </div>
        {accounts.error !== null && <BankRefusal refusal={bankRefusal(accounts.error, "Preview")} />}
        <Button variant="default" title="Join notebook · Tab, Enter or Space" className="self-start" disabled={busy || read?.loading || accounts.result === null || accounts.error !== null} onClick={() => { if (previewUrl !== undefined) void join(previewUrl, ticked); }}><LogIn aria-hidden="true" />Join notebook</Button>
      </> : <p role="alert" className="text-sm text-signal"><span className="sr-only">Error: </span>{CANNOT_READ}</p>}
    </>}
  </div>;
};

/** look.md §12.2/§13.2: named preview sections within the bounded step form. */
const PreviewSection = ({ name, children }: { readonly name: string; readonly children: ReactNode }) => <section aria-label={name} className="flex min-w-0 flex-col gap-2 border-t border-hairline px-3 py-2">
  <h4 className="text-xs font-medium text-ink">{name}</h4>
  <div className="flex min-w-0 flex-col gap-1 break-words text-xs text-ink-muted">{children}</div>
</section>;

/** The facts a person does not need to join, kept for Details (setup-copy.md §1 rule 7). */
const previewDetails = (preview: BankJoinPreview): readonly string[] => [
  ...preview.orgs.map((org) => `Organisation ${org.path}${org.line === null ? "" : `: ${org.line}`}`),
  ...preview.entities.map((entity) => `Entity ${entity.name}: ${entity.aliases.join(", ")}${entity.folder === undefined ? "" : ` (${entity.folder})`}`),
  ...preview.orientation.map((name) => `Orientation: ${name}`),
  `Memories: ${preview.merge.memories === "auto" ? "merge automatically" : "wait for review"}. Review required: ${preview.merge.reviewed.join(", ")}.`,
  `Can read: ${preview.canRead ? "yes" : "no"}. Can push: ${preview.canPush ? "yes" : "no"}.`,
];

/** setup-copy.md §5.8: `{name}: {line}`, its owners and projects, and what a team notebook keeps out; the rest in Details. */
export const JoinPreview = ({ preview }: { readonly preview: BankJoinPreview }) => {
  const [open, setOpen] = useState(false);
  return <section aria-label="Notebook preview" data-join-preview className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
    <header className="flex flex-col gap-1 px-3 py-2">
      <h3 className="text-sm font-medium text-ink">{preview.name}: {preview.line}</h3>
    </header>
    <PreviewSection name="Owners"><p>{preview.owners.join(", ")}</p></PreviewSection>
    <PreviewSection name="Projects">
      {preview.projects.length === 0 && <p>None.</p>}
      {preview.projects.map((project) => <div key={project.path}><p className="font-mono break-all text-ink">{project.path}</p>{project.line !== null && <p>{project.line}</p>}</div>)}
    </PreviewSection>
    {preview.kind === "team" && <p className="border-t border-hairline px-3 py-2 text-xs text-ink-muted">Shared with the team: no personal facts, no secrets.</p>}
    <div className="border-t border-hairline px-3 py-2 text-xs"><Fold summary="Details" open={open} onOpenChange={setOpen}>
      <pre className="font-mono text-2xs break-all whitespace-pre-wrap text-ink-muted select-text">{previewDetails(preview).join("\n")}</pre>
    </Fold></div>
  </section>;
};
