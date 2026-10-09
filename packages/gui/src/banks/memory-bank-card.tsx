import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import { accountName, adminCall, oneLine, uuidv4, uuidv7 } from "@agent-harness/client-runtime";
import type { BankRecord, MemoryPromoteResult, ParamsOf } from "@agent-harness/contracts";
import { Brain, GitPullRequest, Power, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { MintedSessionCard } from "../setup/minted-session-card.js";
import { BankForgeAccess } from "./bank-forge-access.js";
import { JoinBankForm } from "./join-bank.js";
import { PersonalBankForm, TeamBankForm } from "./create-bank.js";
import { BankInvitation } from "./bank-invitation.js";
import { ExternalLink } from "../session/external-link.js";
import { StepStatus } from "../setup/step-status.js";
import { Badge, Dialog, DialogContent, Fold, Tooltip } from "../ui/index.js";
import { BankButton, BankChoices, type BankMode } from "./bank-controls.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** The environment names actions per bank; each card carries only its own bank targets. */
const stepForBank = (step: StepCardProps["step"], bankId: string): StepCardProps["step"] => {
  const result = step.result;
  if (result === null || result.targets === undefined) return step;
  const targets = result.targets.filter((target) => target.kind !== "bank" || target.id === bankId);
  const actions = result.actions.filter((action) => !result.targets?.some((target) => target.action === action) || targets.some((target) => target.action === action));
  return { ...step, result: { ...result, targets, actions } };
};

/** Set up creates or joins banks here; records and status remain in the runtime cache. */
export const MemoryBankCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const read = useObservable(useMemo(() => runtime.requests.cached(environmentId, "banks.list", {}), [runtime, environmentId]));
  const forges = useObservable(useMemo(() => runtime.requests.cached(environmentId, "forge.accounts.list", {}), [runtime, environmentId]));
  const names = useObservable(useMemo(() => runtime.projections.accountNames(environmentId), [runtime, environmentId]));
  const named = (accountIds: readonly string[]) => accountIds.map((accountId) => accountName(names, accountId)).join(", ");
  const sessions = useObservable(runtime.projections.sessionList);
  const repository = sessions.rows.find((row) => row.environmentId === environmentId && row.summary.repositoryIdentity !== null)?.summary.repositoryIdentity;
  const [mode, setMode] = useState<BankMode>("personal");
  const [line, say] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [facts, setFacts] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<BankRecord>();
  const [removeLine, setRemoveLine] = useState<string>();
  const [updates, setUpdates] = useState<Record<string, MemoryPromoteResult | null>>({});
  const verified = forges.result?.accounts.filter((account) => account.identity !== null && account.problem === null) ?? [];
  const command = runtime.capability(environmentId, mode === "join" ? "banks.join" : "banks.create");
  const publication = runtime.capability(environmentId, "banks.publish");
  const validatorUpdate = runtime.capability(environmentId, "banks.validator.update");
  const registryUpdate = runtime.capability(environmentId, "banks.registry.update");
  const forget = runtime.capability(environmentId, "banks.forget");
  const syncCapability = runtime.capability(environmentId, "banks.sync");
  const disabled = busy || command.status === "absent";
  const refresh = () => runtime.requests.refresh(environmentId, "banks.list", {});
  const closeRemove = () => { setRemoving(undefined); setRemoveLine(undefined); };
  const turn = async (bank: BankRecord) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.registry.update", { commandId: uuidv7(clock.now()), bankId: bank.id, enabled: !bank.enabled }));
      if (!answer.ok) say(oneLine(answer.line));
      else refresh();
    } finally { setBusy(false); }
  };
  const remove = async (bank: BankRecord) => {
    say(undefined);
    setRemoveLine(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.forget", { commandId: uuidv7(clock.now()), bankId: bank.id, removeCheckout: false }));
      if (!answer.ok) setRemoveLine(oneLine(answer.line));
      else { closeRemove(); refresh(); }
    } finally { setBusy(false); }
  };
  const sync = async (bankId?: string) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await runtime.requests.call(environmentId, "banks.sync", bankId === undefined ? {} : { bankId });
      if (!answer.ok) say(oneLine(answer.error.message));
      else refresh();
    } finally { setBusy(false); }
  };
  const create = async (name: string, creation: ParamsOf<"banks.create">["creation"]) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.create", { commandId: uuidv7(clock.now()), bankId: uuidv4(), name, creation }));
      if (!answer.ok) say(oneLine(answer.line));
      else runtime.requests.refresh(environmentId, "banks.list", {});
    } finally { setBusy(false); }
  };
  const join = async (url: string, accounts: string[]) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.join", { commandId: uuidv7(clock.now()), bankId: uuidv4(), url, accounts, repositories: "all" }));
      if (!answer.ok) say(oneLine(answer.line));
      else runtime.requests.refresh(environmentId, "banks.list", {});
    } finally { setBusy(false); }
  };
  const publish = async (bankId: string) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.publish", { commandId: uuidv7(clock.now()), bankId }));
      if (!answer.ok) say(oneLine(answer.line));
      else runtime.requests.refresh(environmentId, "banks.list", {});
    } finally { setBusy(false); }
  };
  const updateValidator = async (bankId: string) => {
    say(undefined);
    setBusy(true);
    try {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.validator.update", { commandId: uuidv7(clock.now()), bankId }));
      if (!answer.ok) say(oneLine(answer.line));
      else {
        const landing = answer.result?.landing;
        if (landing !== undefined) setUpdates((held) => ({ ...held, [`${environmentId}:${bankId}`]: landing }));
        runtime.requests.refresh(environmentId, "banks.list", {});
      }
    } finally { setBusy(false); }
  };
  return <>
    <p className="max-w-[56ch] text-sm text-ink-muted">Facts your agents keep</p>
    {(read.result === null || read.result.banks.length === 0) && <StepStatus environmentId={environmentId} step={step} />}
    <div data-bank-content className="flex min-w-0 w-full max-w-[620px] flex-col gap-3.5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-2xs text-ink-faint">Shared notebooks for your accounts and projects.</p>
      <BankButton label="Sync all" icon={RefreshCw} disabled={busy} reason={syncCapability.status === "absent" ? oneLine(syncCapability.message) : read.result?.banks.some((bank) => bank.enabled) ? undefined : "No enabled banks to sync."} onClick={() => void sync()} />
    </div>
    {read.result?.banks.length === 0 && <p className="text-xs text-ink-muted">No banks yet. Create a notebook or join one your team shares.</p>}
    {busy && <p role="status" className="text-xs text-ink-muted">Working on this bank…</p>}
    {read.loading && read.result === null && <p role="status" className="text-xs text-ink-muted">Reading banks…</p>}
    {line !== undefined && removing === undefined && <p role="alert">{line}</p>}
    {read.error !== null && <p role="alert">{oneLine(read.error.message)}</p>}
    <SettingsCardGrid>{read.result?.banks.map((bank) => {
      const subjectStep = stepForBank(step, bank.id);
      const update = updates[`${environmentId}:${bank.id}`];
      const landing = bank.validator?.needsUpdate === false ? bank.status.landing : update ?? bank.status.landing;
      return <section key={bank.id} data-bank-card aria-label={bank.name} className="flex min-w-0 flex-col gap-4 rounded-lg border border-hairline bg-panel p-4 text-xs text-ink">
        <header className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Brain aria-hidden="true" className="size-4 text-ink-muted" />{bank.name}</h3>
          <div className="flex flex-wrap gap-1">
            <Badge variant="outline">{bank.kind ?? "Unspecified kind"}</Badge>
            <Badge variant="secondary">{bank.role === "read-write" ? "Read and write" : "Read only"}</Badge>
            <Badge variant={bank.enabled ? "secondary" : "outline"}>{bank.enabled ? "On" : "Off"}</Badge>
            <Badge variant="outline">{bank.location.kind === "local" ? "Local only" : "Remote"}</Badge>
            {bank.defaultFor.length > 0 && <Badge variant="outline">Default for {named(bank.defaultFor)}</Badge>}
            <Badge variant="outline">{bank.credential === "reference" ? "Key manager" : bank.credential === "forge" ? "Forge access" : "Stored credential"}</Badge>
          </div>
        </header>
        {bank.line !== null && <p className="text-ink-muted">{bank.line}</p>}
        <p className="text-2xs text-ink-faint">{bank.memories} {bank.memories === 1 ? "memory" : "memories"} · {bank.folders} {bank.folders === 1 ? "folder" : "folders"}</p>
        <p className="text-2xs text-ink-faint">{bank.validator === undefined ? "Validator version not reported." : `Validator ${bank.validator.installedVersion ?? "missing"} · ${bank.validator.needsUpdate ? `update to ${bank.validator.currentVersion} available` : "up to date"}`}</p>
        <Fold summary="Repository and scope" open={facts[bank.id] ?? false} onOpenChange={(open) => setFacts((held) => ({ ...held, [bank.id]: open }))} className="text-2xs">
          <dl className="flex flex-col gap-2 text-ink-muted">
            <div><dt>Checkout</dt><dd className="break-all font-mono">{bank.checkout}</dd></div>
            {bank.location.kind === "remote" && <div><dt>Remote</dt><dd className="break-all font-mono">{bank.location.origin}/{bank.location.repository}</dd></div>}
            <div><dt>Accounts</dt><dd>{bank.accounts === "all" ? "All accounts" : named(bank.accounts) || "No accounts"}</dd></div>
            <div><dt>Repositories</dt><dd className="break-all">{bank.repositories === "all" ? "All repositories" : bank.repositories.join(", ") || "No repositories"}</dd></div>
            <div><dt>Last sync</dt><dd>{bank.status.lastSync ?? "Never synced"}</dd></div>
          </dl>
        </Fold>
        <BankForgeAccess environmentId={environmentId} bank={bank} accounts={forges.result?.accounts} />
        {bank.status.manifest.state === "invalid" && <p role="alert">{oneLine(bank.status.manifest.message)}</p>}
        {bank.status.orientation.missing.length > 0 && <p className="text-amber">Missing orientation: {bank.status.orientation.missing.join(", ")}</p>}
        {bank.status.owners.unresolved.length > 0 && <p className="text-amber">Unresolved owners: {bank.status.owners.unresolved.join(", ")}</p>}
        <div className="flex flex-wrap gap-1.5">
          <BankButton label="Sync" icon={RefreshCw} disabled={busy} reason={syncCapability.status === "absent" ? oneLine(syncCapability.message) : !bank.enabled ? "Turn on this bank to sync it." : undefined} onClick={() => void sync(bank.id)} />
          <BankButton label={bank.enabled ? "Turn off" : "Turn on"} icon={Power} disabled={busy} reason={registryUpdate.status === "absent" ? oneLine(registryUpdate.message) : undefined} onClick={() => void turn(bank)} />
          <BankButton label="Remove" icon={Trash2} variant="destructive" disabled={busy} reason={forget.status === "absent" ? oneLine(forget.message) : undefined} onClick={() => setRemoving(bank)} />
        </div>
        {bank.location.kind === "local" && <>
          <p>This bank lives on this machine only until you publish it.</p>
          <BankButton label="Publish" icon={Upload} disabled={busy} reason={publication.status === "absent" ? oneLine(publication.message) : !verified.some((forge) => forge.primary) ? "Connect a verified primary forge to publish." : undefined} onClick={() => void publish(bank.id)} />
        </>}
        {bank.validator?.needsUpdate && <BankButton label="Update validator" icon={RefreshCw} disabled={busy} reason={validatorUpdate.status === "absent" ? oneLine(validatorUpdate.message) : !bank.enabled ? "Turn on this bank first." : bank.role !== "read-write" ? "This bank is read only." : landing.state === "awaiting-review" ? "An owner review is already pending." : undefined} onClick={() => void updateValidator(bank.id)} />}
        {landing.state === "awaiting-review" && <Tooltip content="Awaiting owner review" keys="Tab, Enter or Space"><span className="inline-flex"><ExternalLink look="inline-flex items-center gap-1.5 text-beam-text underline" url={landing.pullRequest}><GitPullRequest aria-hidden="true" className="size-4" />Awaiting owner review</ExternalLink></span></Tooltip>}
        {landing.state === "failed" && <p role="alert">{oneLine(`${update?.state === "failed" ? "Validator update" : "Landing"} failed at ${landing.step}: ${landing.reason}`)}</p>}
        {update?.state === "landed" && <p>Validator update verified on main.</p>}
        {update === null && <p>Validator is up to date.</p>}
        {bank.kind === "team" && bank.location.kind === "remote" && <BankInvitation environmentId={environmentId} location={bank.location} forges={forges.result?.accounts ?? []} />}
        {bank.status.manifest.state === "awaiting-review" && landing.state !== "awaiting-review" && <Tooltip content="Awaiting owner review" keys="Tab, Enter or Space"><span className="inline-flex"><ExternalLink look="inline-flex items-center gap-1.5 text-beam-text underline" url={bank.status.manifest.pullRequest}><GitPullRequest aria-hidden="true" className="size-4" />Awaiting owner review</ExternalLink></span></Tooltip>}
        {bank.enabled && bank.role === "read-write" ? <MintedSessionCard environmentId={environmentId} step={subjectStep} subject={bank.id} artefact={{ kind: "folder", path: bank.checkout }} startLabel="Describe this bank" {...((landing.state === "awaiting-review" || bank.status.manifest.state === "awaiting-review") && { outcome: "landed and awaiting review" })} /> : <p className="text-2xs text-ink-faint">{bank.enabled ? "This bank is read only." : "Turn on this bank to use it in runs."}</p>}
      </section>;
    })}</SettingsCardGrid>
    <BankChoices value={mode} choose={(next) => { say(undefined); setMode(next); }} />
    {command.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={command}><p>Read-only: {oneLine(command.message)}</p></AccessUnavailable>}
    {forges.error !== null && <p role="alert">{oneLine(forges.error.message)}</p>}
    <div data-bank-form className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
    {read.result !== null && (mode === "personal"
      ? <PersonalBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} firstProject={repository?.split("/").at(-1)?.replace(/\.git$/, "") ?? ""} />
      : mode === "team" ? <TeamBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} />
      : <JoinBankForm key={environmentId} environmentId={environmentId} busy={disabled} join={join} />)}
    </div>
    </div>
    <Dialog open={removing !== undefined} onOpenChange={(open) => { if (!open && !busy) closeRemove(); }}>
      {removing !== undefined && <DialogContent title={`Remove ${removing.name}?`} description="Runs will stop using this bank. Its checkout stays on this machine, and its remote repository is kept.">
        <div className="flex flex-wrap justify-end gap-2">
          <BankButton label="Cancel" icon={X} disabled={busy} onClick={closeRemove} />
          <BankButton label="Remove bank" icon={Trash2} variant="destructive" disabled={busy} reason={forget.status === "absent" ? oneLine(forget.message) : undefined} onClick={() => void remove(removing)} />
        </div>
        {removeLine !== undefined && <p role="alert">{removeLine}</p>}
      </DialogContent>}
    </Dialog>
  </>;
};
