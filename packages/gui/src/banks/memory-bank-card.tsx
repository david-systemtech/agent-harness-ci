import { adminCall, oneLine, uuidv4, uuidv7 } from "@agent-harness/client-runtime";
import type { ParamsOf } from "@agent-harness/contracts";
import { useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { MintedSessionCard } from "../setup/minted-session-card.js";
import { JoinBankForm } from "./join-bank.js";
import { PersonalBankForm, TeamBankForm } from "./create-bank.js";
import { BankInvitation } from "./bank-invitation.js";
import { ExternalLink } from "../session/external-link.js";
import { StepStatus } from "../setup/step-status.js";
import { Button } from "../ui/index.js";
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
  const sessions = useObservable(runtime.projections.sessionList);
  const repository = sessions.rows.find((row) => row.environmentId === environmentId && row.summary.repositoryIdentity !== null)?.summary.repositoryIdentity;
  const [mode, setMode] = useState<"personal" | "team" | "join">("personal");
  const [line, say] = useState<string>();
  const [busy, setBusy] = useState(false);
  const verified = forges.result?.accounts.filter((account) => account.identity !== null && account.problem === null) ?? [];
  const command = runtime.capability(environmentId, mode === "join" ? "banks.join" : "banks.create");
  const publication = runtime.capability(environmentId, "banks.publish");
  const disabled = busy || command.status === "absent";
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
  return <>
    {(read.result === null || read.result.banks.length === 0) && <StepStatus environmentId={environmentId} step={step} />}
    <div role="group" aria-label="Bank kind">
      <Button aria-pressed={mode === "personal"} onClick={() => { say(undefined); setMode("personal"); }}>Personal</Button>
      <Button aria-pressed={mode === "team"} onClick={() => { say(undefined); setMode("team"); }}>Team</Button>
      <Button aria-pressed={mode === "join"} onClick={() => { say(undefined); setMode("join"); }}>Join a bank</Button>
    </div>
    {command.status === "absent" && <p>Read-only: {oneLine(command.message)}</p>}
    {forges.error !== null && <p role="alert">{oneLine(forges.error.message)}</p>}
    {read.result !== null && (mode === "personal"
      ? <PersonalBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} firstProject={repository?.split("/").at(-1)?.replace(/\.git$/, "") ?? ""} />
      : mode === "team" ? <TeamBankForm key={environmentId} environmentId={environmentId} forges={verified} busy={disabled} create={create} />
      : <JoinBankForm key={environmentId} environmentId={environmentId} busy={disabled} join={join} />)}
    {line !== undefined && <p role="alert">{line}</p>}
    {read.error !== null && <p role="alert">{oneLine(read.error.message)}</p>}
    {read.result?.banks.map((bank) => {
      const subjectStep = stepForBank(step, bank.id);
      return <section key={bank.id} aria-label={bank.name}>
        <h3>{bank.name}</h3>
        {bank.location.kind === "local" && <>
          <p>This bank lives on this machine only until you publish it.</p>
          <Button disabled={busy || publication.status === "absent" || !verified.some((forge) => forge.primary)} onClick={() => void publish(bank.id)}>Publish</Button>
        </>}
        {bank.status.landing.state === "awaiting-review" && <ExternalLink url={bank.status.landing.pullRequest}>Awaiting owner review</ExternalLink>}
        {bank.kind === "team" && bank.location.kind === "remote" && <BankInvitation environmentId={environmentId} location={bank.location} forges={forges.result?.accounts ?? []} />}
        {bank.role === "read-write" ? <MintedSessionCard environmentId={environmentId} step={subjectStep} subject={bank.id} artefact={{ kind: "folder", path: bank.checkout }} startLabel="Describe this bank" {...((bank.status.landing.state === "awaiting-review" || bank.status.manifest.state === "awaiting-review") && { outcome: "landed and awaiting review" })} /> : <StepStatus environmentId={environmentId} step={step} />}
      </section>;
    })}
  </>;
};
