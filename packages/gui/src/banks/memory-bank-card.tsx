import { SettingsCardGrid } from "../settings/part.js";
import { AccessUnavailable } from "../connections/limited-access.js";
import { accountName, adminCall, plainRefusal, uuidv4, uuidv7, type AdminOutcome, type PlainRefusal, type RefusedAnswer } from "@agent-harness/client-runtime";
import type { BankRecord, CommandMethodName, ForgeAccountRecord, MemoryPromoteResult, ParamsOf } from "@agent-harness/contracts";
import { Brain, GitPullRequest, Power, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { MintedSessionCard } from "../setup/minted-session-card.js";
import { BankForgeAccess, bankWithCurrentForge } from "./bank-forge-access.js";
import { JoinBankForm } from "./join-bank.js";
import { PersonalBankForm, TeamBankForm } from "./create-bank.js";
import { bankCheckIncomplete, stepForBank } from "./bank-step.js";
import { BankInvitation } from "./bank-invitation.js";
import { ExternalLink } from "../session/external-link.js";
import { StepStatus } from "../setup/step-status.js";
import { Badge, Dialog, DialogContent, Fold } from "../ui/index.js";
import { BankButton, BankChoices, BankRefusal, GoToForges, type BankMode } from "./bank-controls.js";
import { bankBadges, bankRefusal, descriptionWords, hostOf } from "./bank-words.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** What a bank command did: done, or its refusal in plain words. */
type Sent = { readonly ok: true } | { readonly ok: false; readonly refusal: PlainRefusal };

/** An admin command's outcome, its refusal worded for the button `verb` by `words` (`bankRefusal` where the environment words it in §5.8). */
const said = <N extends CommandMethodName>(outcome: AdminOutcome<N>, verb: string, words: (refusal: RefusedAnswer, verb: string) => PlainRefusal = plainRefusal): Sent =>
  outcome.ok ? { ok: true } : { ok: false, refusal: words(outcome.refusal, verb) };

/** The describing conversation in setup-copy.md §5.8's words; a review waits on the host the pull request is on. */
const describeWords = (host: string) => ({
  start: "Describe it", open: "Describe it", running: "Writing the description…", waiting: "Waiting for your answer",
  landed: "Saved", review: `Saved. Waiting for your approval on ${host}.`, stopped: "Stopped",
});
const DESCRIBE_LINE = "Now describe your notebook. An agent asks a few questions and writes the description.";

/**
 * setup-copy.md §5.8's ready-to-go row, visible text: the main forge a new own
 * notebook goes to, or what is missing or needs a fix with Go to Forges (the own notebook can
 * still be kept on this computer). A team notebook names its forge in its own
 * form, so its row shows only while there is none.
 */
const ReadyRow = ({ environmentId, mode, accounts, forges }: { readonly environmentId: string; readonly mode: Exclude<BankMode, "join">; readonly accounts: readonly ForgeAccountRecord[]; readonly forges: readonly ForgeAccountRecord[] }) => {
  const forge = forges.find((forge) => forge.primary);
  if (mode === "team" && forges.length > 0) return null;
  if (forge?.identity != null) return <p data-bank-ready className="flex flex-wrap items-center gap-2 text-sm text-ink">Forge: {forge.identity.login} on {hostOf(forge.origin)}<Badge variant="secondary">Ready</Badge></p>;
  const needsFix = accounts.find((account) => account.primary && account.problem !== null) ?? (forges.length === 0 ? accounts.find((account) => account.problem !== null) : undefined);
  return <div data-bank-ready className="flex flex-wrap items-center gap-2 text-sm text-ink">
    <p>{needsFix !== undefined ? `Your account on ${hostOf(needsFix.origin)} needs a fix first.` : forges.length > 0 ? "Choose your main forge. New notebooks go there." : "No forge yet."}</p>
    <GoToForges environmentId={environmentId} />
  </div>;
};

/** A notebook's facts beyond its badges (setup-copy.md §5.8, "the rest in Details"). */
const BankDetails = ({ bank, named }: { readonly bank: BankRecord; readonly named: (accountIds: readonly string[]) => string }) => {
  const [open, setOpen] = useState(false);
  const { manifest, orientation, owners } = bank.status;
  const facts: readonly (readonly [string, string])[] = [
    ["Changes", bank.role === "read-write" ? "Read and write" : "Read only"],
    ...(bank.defaultFor.length > 0 ? [["Default for", named(bank.defaultFor)] as const] : []),
    ["Sign-in", bank.credential === "reference" ? "Key manager" : bank.credential === "forge" ? "Forge account" : "Saved token"],
    ["Folder", bank.checkout],
    ...(bank.location.kind === "remote" ? [["Repository", `${bank.location.origin}/${bank.location.repository}`] as const] : []),
    ["Accounts", bank.accounts === "all" ? "All accounts" : named(bank.accounts) || "No accounts"],
    ["Repositories", bank.repositories === "all" ? "All repositories" : bank.repositories.join(", ") || "No repositories"],
    ["Last sync", bank.status.lastSync ?? "Never synced"],
    ["Notes", `${bank.memories} ${bank.memories === 1 ? "memory" : "memories"} in ${bank.folders} ${bank.folders === 1 ? "folder" : "folders"}`],
    ["Rules", bank.validator === undefined ? "Version not reported" : `Version ${bank.validator.installedVersion ?? "missing"}${bank.validator.needsUpdate ? `, version ${bank.validator.currentVersion} available` : ", up to date"}`],
    ...(manifest.state === "invalid" ? [["Description", `${manifest.rule}: ${manifest.message}`] as const] : []),
    ...(orientation.missing.length > 0 ? [["Orientation missing", orientation.missing.join(", ")] as const] : []),
    ...(owners.unresolved.length > 0 ? [["Owners not found", owners.unresolved.join(", ")] as const] : []),
  ];
  return <Fold summary="Details" open={open} onOpenChange={setOpen} className="text-2xs">
    <dl className="flex flex-col gap-2 text-ink-muted">
      {facts.map(([term, value]) => <div key={term}><dt>{term}</dt><dd className="break-all">{value}</dd></div>)}
    </dl>
  </Fold>;
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
  const [refused, say] = useState<{ readonly refusal: PlainRefusal; readonly at: "card" | "form" }>();
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<BankRecord>();
  const [removeRefusal, setRemoveRefusal] = useState<PlainRefusal>();
  const [updates, setUpdates] = useState<Record<string, MemoryPromoteResult | null>>({});
  const verified = forges.result?.accounts.filter((account) => account.identity !== null && account.problem === null) ?? [];
  const main = forges.result?.accounts.find((account) => account.primary);
  /** Why a notebook cannot move to the main forge yet, as the environment would refuse it (setup-copy.md §5.8). */
  const mainHeld = main === undefined ? "Choose your main forge before you move this notebook to it."
    : main.identity === null || main.problem !== null ? `Your account on ${hostOf(main.origin)} needs a fix first.` : undefined;
  const command = runtime.capability(environmentId, mode === "join" ? "banks.join" : "banks.create");
  const publication = runtime.capability(environmentId, "banks.publish");
  const validatorUpdate = runtime.capability(environmentId, "banks.validator.update");
  const registryUpdate = runtime.capability(environmentId, "banks.registry.update");
  const forget = runtime.capability(environmentId, "banks.forget");
  const syncCapability = runtime.capability(environmentId, "banks.sync");
  const verifyCapability = runtime.capability(environmentId, "banks.verify");
  const disabled = busy || command.status === "absent";
  const refresh = () => runtime.requests.refresh(environmentId, "banks.list", {});
  const closeRemove = () => { setRemoving(undefined); setRemoveRefusal(undefined); };
  /** Runs one bank command, saying its refusal beside what asked: a notebook's card, the form, or the Remove dialog; `done` runs on success. */
  const send = async (call: () => Promise<Sent>, done: () => void = refresh, at: "card" | "form" | "remove" = "card") => {
    say(undefined);
    if (at === "remove") setRemoveRefusal(undefined);
    setBusy(true);
    try {
      const answer = await call();
      if (answer.ok) done();
      else if (at === "remove") setRemoveRefusal(answer.refusal);
      else say({ refusal: answer.refusal, at });
    } finally { setBusy(false); }
  };
  const turn = (bank: BankRecord) => send(async () => said(await adminCall(() => runtime.requests.call(environmentId, "banks.registry.update", { commandId: uuidv7(clock.now()), bankId: bank.id, enabled: !bank.enabled })), bank.enabled ? "Turn off" : "Turn on"));
  const remove = (bank: BankRecord) => send(async () => said(await adminCall(() => runtime.requests.call(environmentId, "banks.forget", { commandId: uuidv7(clock.now()), bankId: bank.id, removeCheckout: false })), "Remove notebook"), () => { closeRemove(); refresh(); }, "remove");
  const sync = (bankId?: string) => send(async () => {
    const answer = await runtime.requests.call(environmentId, "banks.sync", bankId === undefined ? {} : { bankId });
    return answer.ok ? { ok: true } : { ok: false, refusal: plainRefusal(answer.error, bankId === undefined ? "Sync all" : "Sync") };
  });
  const verify = (bankId: string) => send(async () => {
    const answer = await runtime.requests.call(environmentId, "banks.verify", { bankId });
    return answer.ok ? { ok: true } : { ok: false, refusal: plainRefusal(answer.error, "Check again") };
  });
  const create = (name: string, creation: ParamsOf<"banks.create">["creation"]) => send(async () => said(await adminCall(() => runtime.requests.call(environmentId, "banks.create", { commandId: uuidv7(clock.now()), bankId: uuidv4(), name, creation })), creation.kind === "personal" && creation.localOnly ? "Keep it on this computer for now" : "Create notebook", bankRefusal), refresh, "form");
  const join = (url: string, accounts: string[]) => send(async () => said(await adminCall(() => runtime.requests.call(environmentId, "banks.join", { commandId: uuidv7(clock.now()), bankId: uuidv4(), url, accounts, repositories: "all" })), "Join notebook", bankRefusal), refresh, "form");
  const publish = (bankId: string) => send(async () => said(await adminCall(() => runtime.requests.call(environmentId, "banks.publish", { commandId: uuidv7(clock.now()), bankId })), "Move to your forge", bankRefusal));
  const updateValidator = (bankId: string) => send(async () => {
    const answer = await adminCall(() => runtime.requests.call(environmentId, "banks.validator.update", { commandId: uuidv7(clock.now()), bankId }));
    const landing = answer.ok ? answer.result?.landing : undefined;
    if (landing !== undefined) setUpdates((held) => ({ ...held, [`${environmentId}:${bankId}`]: landing }));
    return said(answer, "Update the rules");
  });
  const banks = read.result?.banks ?? [];
  return <>
    {(read.result === null || banks.length === 0 || bankCheckIncomplete(step)) && <StepStatus environmentId={environmentId} step={step} />}
    <div data-bank-content className="flex min-w-0 w-full max-w-[620px] flex-col gap-3.5">
    {banks.length > 0 && <div className="flex flex-wrap items-center justify-end gap-2">
      <BankButton label="Sync all" icon={RefreshCw} disabled={busy} reason={syncCapability.status === "absent" ? syncCapability.message : banks.some((bank) => bank.enabled) ? undefined : "Turn on a notebook to sync it."} onClick={() => void sync()} />
    </div>}
    {busy && <p role="status" className="text-xs text-ink-muted">Working on it…</p>}
    {read.loading && read.result === null && <p role="status" className="text-xs text-ink-muted">Reading your notebooks…</p>}
    {refused?.at === "card" && removing === undefined && <BankRefusal refusal={refused.refusal} />}
    {read.error !== null && <BankRefusal refusal={plainRefusal(read.error, "Check again")} />}
    <SettingsCardGrid>{banks.map((record) => {
      const bank = bankWithCurrentForge(record, forges.result?.accounts);
      const subjectStep = stepForBank(step, bank);
      const update = updates[`${environmentId}:${bank.id}`];
      const landing = bank.validator?.needsUpdate === false ? bank.status.landing : update ?? bank.status.landing;
      const forgeHost = bank.location.kind === "remote" ? hostOf(bank.location.origin) : null;
      const review = bank.status.manifest.state === "awaiting-review" ? { line: `Saved. Waiting for your approval on ${hostOf(bank.status.manifest.pullRequest)}.`, url: bank.status.manifest.pullRequest }
        : landing.state === "awaiting-review" ? { line: `${bank.name}'s latest changes are waiting for your approval on ${hostOf(landing.pullRequest)}.`, url: landing.pullRequest } : undefined;
      return <section key={bank.id} data-bank-card aria-label={bank.name} className="flex min-w-0 flex-col gap-4 rounded-lg border border-hairline bg-panel p-4 text-xs text-ink">
        <header className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><Brain aria-hidden="true" className="size-4 text-ink-muted" />{bank.name}</h3>
          <div className="flex flex-wrap gap-1">
            {bankBadges(bank).map((badge) => <Badge key={badge} data-bank-badge variant={badge === "On" ? "secondary" : "outline"}>{badge}</Badge>)}
            <Badge data-bank-badge variant={bank.status.manifest.state === "valid" ? "secondary" : "outline"}>{descriptionWords(bank)}</Badge>
          </div>
        </header>
        {bank.line !== null && <p className="text-ink-muted">{bank.line}</p>}
        <BankForgeAccess environmentId={environmentId} bank={bank} accounts={forges.result?.accounts} check={{ busy, reason: verifyCapability.status === "absent" ? verifyCapability.message : undefined, run: () => void verify(bank.id) }} />
        {landing.state === "failed" && <BankRefusal refusal={{ line: forgeHost === null ? `The last change to ${bank.name} could not be saved.` : `The last change to ${bank.name} could not be saved to ${forgeHost}.`, details: [`${landing.step}: ${landing.reason}`] }} />}
        {review !== undefined && <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm">{review.line}</p>
          <ExternalLink look="inline-flex items-center gap-1.5 text-beam-text underline" url={review.url}><GitPullRequest aria-hidden="true" className="size-4" />Open the review</ExternalLink>
        </div>}
        <div className="flex flex-wrap gap-1.5">
          <BankButton label="Sync" icon={RefreshCw} disabled={busy} reason={syncCapability.status === "absent" ? syncCapability.message : !bank.enabled ? `Turn on ${bank.name} to sync it.` : undefined} onClick={() => void sync(bank.id)} />
          <BankButton label={bank.enabled ? "Turn off" : "Turn on"} icon={Power} disabled={busy} reason={registryUpdate.status === "absent" ? registryUpdate.message : undefined} onClick={() => void turn(bank)} />
          <BankButton label="Remove" icon={Trash2} variant="destructive" disabled={busy} reason={forget.status === "absent" ? forget.message : undefined} onClick={() => setRemoving(bank)} />
        </div>
        {bank.location.kind === "local" && <div className="flex flex-col items-start gap-2">
          <p>{bank.name} is on this computer only. Move it to your forge to use it on other computers too.</p>
          <BankButton label="Move to your forge" icon={Upload} disabled={busy} reason={publication.status === "absent" ? publication.message : mainHeld} onClick={() => void publish(bank.id)} />
          {publication.status === "present" && mainHeld !== undefined && <GoToForges environmentId={environmentId} />}
        </div>}
        {bank.validator?.needsUpdate && <div className="flex flex-col items-start gap-2">
          <p>{bank.name} uses an older copy of the notebook rules.</p>
          <BankButton label="Update the rules" icon={RefreshCw} disabled={busy} reason={validatorUpdate.status === "absent" ? validatorUpdate.message : !bank.enabled ? `Turn on ${bank.name} first.` : bank.role !== "read-write" ? `You can look at ${bank.name} but not change it.` : landing.state === "awaiting-review" ? "An update is already waiting for your approval." : undefined} onClick={() => void updateValidator(bank.id)} />
        </div>}
        {update?.state === "landed" && <p>The rules are up to date.</p>}
        {update === null && <p>The rules were up to date already.</p>}
        {bank.kind === "team" && bank.location.kind === "remote" && <BankInvitation environmentId={environmentId} location={bank.location} forges={forges.result?.accounts ?? []} />}
        {bank.enabled && bank.role === "read-write"
          ? <MintedSessionCard environmentId={environmentId} step={subjectStep} subject={bank.id} artefact={{ kind: "folder", path: bank.checkout }} words={describeWords(review === undefined ? forgeHost ?? "your forge" : hostOf(review.url))} {...(bank.status.manifest.state === "missing" && { startLine: DESCRIBE_LINE })} {...(!bankCheckIncomplete(step) && review !== undefined && { outcome: "landed and awaiting review" })} />
          : <p className="text-2xs text-ink-muted">{bank.enabled ? `You can look at ${bank.name} but not change it.` : `Turn on ${bank.name} so agents use it.`}</p>}
        <BankDetails bank={bank} named={named} />
      </section>;
    })}</SettingsCardGrid>
    <BankChoices value={mode} choose={(next) => { say(undefined); setMode(next); }} />
    {command.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={command}><p>You can look but not change this. {command.message}</p></AccessUnavailable>}
    {forges.error !== null && <BankRefusal refusal={plainRefusal(forges.error, "Check again")} />}
    {mode !== "join" && forges.result !== null && <ReadyRow environmentId={environmentId} mode={mode} accounts={forges.result.accounts} forges={verified} />}
    <div data-bank-form className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
    {read.result !== null && (mode === "personal"
      ? <PersonalBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} firstProject={repository?.split("/").at(-1)?.replace(/\.git$/, "") ?? ""} />
      : mode === "team" ? <TeamBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} />
      : <JoinBankForm key={environmentId} environmentId={environmentId} busy={disabled} join={join} />)}
    </div>
    {refused?.at === "form" && <BankRefusal refusal={refused.refusal} />}
    </div>
    <Dialog open={removing !== undefined} onOpenChange={(open) => { if (!open && !busy) closeRemove(); }}>
      {removing !== undefined && <DialogContent title={`Remove ${removing.name}?`} description="Agents will stop using it. Its folder stays on this computer, and its repository on the forge is kept.">
        <div className="flex flex-wrap justify-end gap-2">
          <BankButton label="Cancel" icon={X} disabled={busy} onClick={closeRemove} />
          <BankButton label="Remove notebook" icon={Trash2} variant="destructive" disabled={busy} reason={forget.status === "absent" ? forget.message : undefined} onClick={() => void remove(removing)} />
        </div>
        {removeRefusal !== undefined && <BankRefusal refusal={removeRefusal} />}
      </DialogContent>}
    </Dialog>
  </>;
};
