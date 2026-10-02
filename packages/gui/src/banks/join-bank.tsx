import { oneLine } from "@agent-harness/client-runtime";
import type { BankJoinPreview } from "@agent-harness/contracts";
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
    <Field label="Bank link"><Input value={url} onChange={(event) => { setUrl(event.target.value); preview(undefined); select([]); }} /></Field>
    <Button disabled={busy || url.trim() === "" || read?.loading === true} onClick={() => {
      const next = url.trim();
      preview(next);
      runtime.requests.refresh(environmentId, "banks.join.preview", { url: next });
    }}>Preview</Button>
    {read?.error != null && <p role="alert">{oneLine(read.error.message)}</p>}
    {result != null && <>
      <JoinPreview preview={result} />
      <div role="group" aria-label="Accounts to attach">
        {accounts.result?.accounts.map((account) => <label key={account.id} className="flex items-center gap-2">
          <input type="checkbox" checked={selected.includes(account.id)} onChange={(event) => select((picked) => event.target.checked ? [...picked, account.id] : picked.filter((id) => id !== account.id))} />
          {account.label}
        </label>)}
      </div>
      {accounts.error !== null && <p role="alert">{oneLine(accounts.error.message)}</p>}
      <Button disabled={busy || !result.canRead || read?.loading || accounts.result === null || accounts.error !== null} onClick={() => { if (previewUrl !== undefined) void join(previewUrl, selected); }}>Join</Button>
    </>}
  </>;
};

const JoinPreview = ({ preview }: { readonly preview: BankJoinPreview }) => <section aria-label="Bank preview" className="flex flex-col gap-2">
  <h3>{preview.name}</h3>
  <p>{preview.line}</p>
  <h4>Organisations</h4>
  {preview.orgs.map((org) => <div key={org.path}><p>{org.path}</p>{org.line !== null && <p>{org.line}</p>}</div>)}
  <h4>Projects</h4>
  {preview.projects.map((project) => <div key={project.path}><p>{project.path}</p>{project.line !== null && <p>{project.line}</p>}</div>)}
  <h4>Entities</h4>
  {preview.entities.map((entity) => <p key={entity.name}>{entity.name}: {entity.aliases.join(", ")}{entity.folder !== undefined && ` (${entity.folder})`}</p>)}
  <h4>Orientation</h4>
  {preview.orientation.map((name) => <p key={name}>{name}</p>)}
  <p>Owners: {preview.owners.join(", ")}</p>
  <p>Memories: {preview.merge.memories === "auto" ? "merge automatically" : "wait for review"}. Review required: {preview.merge.reviewed.join(", ")}.</p>
  {preview.kind === "team" && <p>Shared with the team: no personal facts, no secrets.</p>}
  <p>Can read: {preview.canRead ? "yes" : "no"}. Can push: {preview.canPush ? "yes" : "no"}.</p>
</section>;
