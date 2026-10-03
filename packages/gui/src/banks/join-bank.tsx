import { oneLine } from "@agent-harness/client-runtime";
import type { BankJoinPreview } from "@agent-harness/contracts";
import { Eye, LogIn } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Button, Field, Input } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";

export const JoinBankForm = ({ environmentId, busy, join }: {
  readonly environmentId: string;
  readonly busy: boolean;
  readonly join: (url: string, accounts: string[]) => Promise<void>;
}) => {
  const runtime = useRuntime();
  const [url, setUrl] = useState("");
  const [previewUrl, preview] = useState<string>();
  const [selected, select] = useState<string[]>([]);
  const accounts = useObservable(useMemo(() => runtime.requests.cached(environmentId, "accounts.list", {}), [runtime, environmentId]));
  const read = useFollowed(useMemo(() => previewUrl === undefined ? undefined : runtime.requests.cached(environmentId, "banks.join.preview", { url: previewUrl }), [runtime, environmentId, previewUrl]));
  const result = read?.error === null ? read.result : null;
  return <>
    <div className="max-w-[320px]"><Field label="Bank link"><Input title="Bank link · Tab, type a URL" value={url} onChange={(event) => { setUrl(event.target.value); preview(undefined); select([]); }} /></Field></div>
    <Button variant="outline" title="Preview · Tab, Enter or Space" className="self-start" disabled={busy || url.trim() === "" || read?.loading === true} onClick={() => {
      const next = url.trim();
      preview(next);
      runtime.requests.refresh(environmentId, "banks.join.preview", { url: next });
    }}><Eye aria-hidden="true" />Preview</Button>
    {read?.error != null && <p role="alert">{oneLine(read.error.message)}</p>}
    {result != null && <>
      <JoinPreview preview={result} />
      <div role="group" aria-label="Accounts to attach" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
        <h4 className="text-xs font-medium">Accounts to attach</h4>
        {accounts.result?.accounts.map((account) => <label key={account.id} className="flex items-center gap-2 text-xs">
          <input type="checkbox" title={`${account.label} · Tab, Space`} checked={selected.includes(account.id)} onChange={(event) => select((picked) => event.target.checked ? [...picked, account.id] : picked.filter((id) => id !== account.id))} />
          {account.label}
        </label>)}
      </div>
      {accounts.error !== null && <p role="alert">{oneLine(accounts.error.message)}</p>}
      <Button variant="default" title="Join · Tab, Enter or Space" className="self-start" disabled={busy || !result.canRead || read?.loading || accounts.result === null || accounts.error !== null} onClick={() => { if (previewUrl !== undefined) void join(previewUrl, selected); }}><LogIn aria-hidden="true" />Join</Button>
    </>}
  </>;
};

/** look.md §12.2/§13.2: named preview sections within the bounded step form. */
const PreviewSection = ({ name, children }: { readonly name: string; readonly children: ReactNode }) => <section aria-label={name} className="flex min-w-0 flex-col gap-2 border-t border-hairline px-3 py-2">
  <h4 className="text-xs font-medium text-ink">{name}</h4>
  <div className="flex min-w-0 flex-col gap-1 break-words text-xs text-ink-muted">{children}</div>
</section>;

export const JoinPreview = ({ preview }: { readonly preview: BankJoinPreview }) => <section aria-label="Bank preview" data-join-preview className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-hairline bg-panel">
  <header className="flex flex-col gap-1 px-3 py-2">
    <h3 className="text-sm font-medium text-ink">{preview.name}</h3>
    <p className="text-xs text-ink-muted">{preview.line}</p>
  </header>
  <PreviewSection name="Organisations">
    {preview.orgs.length === 0 && <p>None.</p>}
    {preview.orgs.map((org) => <div key={org.path}><p className="font-mono break-all text-ink">{org.path}</p>{org.line !== null && <p>{org.line}</p>}</div>)}
  </PreviewSection>
  <PreviewSection name="Projects">
    {preview.projects.length === 0 && <p>None.</p>}
    {preview.projects.map((project) => <div key={project.path}><p className="font-mono break-all text-ink">{project.path}</p>{project.line !== null && <p>{project.line}</p>}</div>)}
  </PreviewSection>
  <PreviewSection name="Entities">
    {preview.entities.length === 0 && <p>None.</p>}
    {preview.entities.map((entity) => <p key={entity.name}>{entity.name}: {entity.aliases.join(", ")}{entity.folder !== undefined && ` (${entity.folder})`}</p>)}
  </PreviewSection>
  <PreviewSection name="Orientation">
    {preview.orientation.length === 0 && <p>None.</p>}
    {preview.orientation.map((name) => <p key={name} className="font-mono">{name}</p>)}
  </PreviewSection>
  <PreviewSection name="Access and review">
    <p>Owners: {preview.owners.join(", ")}</p>
    <p>Memories: {preview.merge.memories === "auto" ? "merge automatically" : "wait for review"}. Review required: {preview.merge.reviewed.join(", ")}.</p>
    {preview.kind === "team" && <p>Shared with the team: no personal facts, no secrets.</p>}
    <p>Can read: {preview.canRead ? "yes" : "no"}. Can push: {preview.canPush ? "yes" : "no"}.</p>
  </PreviewSection>
</section>;
