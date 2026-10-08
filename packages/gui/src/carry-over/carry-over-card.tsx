import { AccessUnavailable } from "../connections/limited-access.js";
import { adminCall, derived, plainRefusal, stepLine, uuidv7, type CachedAnswer, type PlainRefusal } from "@agent-harness/client-runtime";
import type { AccountRecord, CarryOverInventory } from "@agent-harness/contracts";
import { Download, RefreshCw } from "lucide-react";
import { CountGrid } from "./count-grid.js";
import { useEffect, useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { SetupNotice } from "../setup/notice.js";
import { StepStatus } from "../setup/step-status.js";
import { Button, Fold } from "../ui/index.js";
import { useClock, useFollowed, useObservable, useRuntime } from "../window-context.js";
import { CheckoutOffer } from "./checkout-offer.js";
import { useBringOverEarlierWork } from "./earlier-work.js";
import { counted, ImportReport, type AccountReport } from "./import-report.js";
import { MemoryAssignment } from "./memory-assignment.js";
import { useNoticeDetails } from "./notice-details.js";
import { StateImportSection } from "./state-import-section.js";

/** The card's line once everything is brought over; also the step registry's done line, so the card leaves it to the step's line when that says it. */
const ALREADY_HERE = "Everything is already here.";

/** What the fold `What will not come over` lists (setup-copy.md §5.3; ADR 0021). */
const NOT_COMING = [
  "Your Claude Code settings, hooks and plugins",
  "Personal MCP servers and permission rules",
  "Subagents",
  "Prompt history",
  "Repository trust",
] as const;

/** An adopted account with its inventory, once the environment has listed it. */
interface Found {
  readonly account: AccountRecord;
  readonly inventory: CarryOverInventory;
}

/** Whether an import has brought something of the account over already: its directory holds sessions or notes the environment holds. */
const broughtBefore = ({ sessions, memory }: CarryOverInventory): boolean => sessions.new < sessions.total || memory.new < memory.folders;

/** Whether the account's directory holds anything to bring over at all. */
const holdsAnything = ({ sessions, memory, skills }: CarryOverInventory): boolean => sessions.total + memory.folders + skills.skills + skills.commands > 0;

/** The skill folders and command files an account's directory holds, which the summary calls skills. */
const skillCount = ({ skills }: CarryOverInventory): number => skills.skills + skills.commands;

/** The fold `What will come over`: each account's counts by kind. */
const ComingOver = ({ found }: { readonly found: readonly Found[] }) => {
  const [open, setOpen] = useState(false);
  return (
    <Fold summary="What will come over" open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 flex-col gap-3">
        {found.map(({ account, inventory }) => (
          <div key={account.id} className="flex min-w-0 flex-col gap-1">
            <p className="text-xs font-medium text-ink">{account.label}</p>
            <CountGrid label={account.label} rows={[["Past chats", inventory.sessions.total], ["New chats", inventory.sessions.new], ["Notes folders", inventory.memory.folders], ["Skills", skillCount(inventory)]]} />
          </div>
        ))}
      </div>
    </Fold>
  );
};

/** The fold `What will not come over`: what Claude Code keeps to itself. */
const NotComingOver = () => {
  const [open, setOpen] = useState(false);
  return (
    <Fold summary="What will not come over" open={open} onOpenChange={setOpen}>
      <ul className="list-disc pl-5 text-sm text-ink">{NOT_COMING.map((item) => <li key={item}>{item}</li>)}</ul>
      <p className="text-sm text-ink-muted">Claude Code keeps all of these. You can set them up again in agent-harness when you need them.</p>
    </Fold>
  );
};

/**
 * Carry over (setup-copy.md §5.3; ADR 0021, ADR 0036; #1844): one sentence
 * per Claude Code sign-in saying what its folder holds, and one button that
 * brings every adopted account over, skills ticked, together with the earlier
 * work the first time. The counts wait in the fold `What will come over`,
 * what stays behind in `What will not come over`. With nothing to bring over,
 * the card is two lines; a read that failed is a notice with Check again and
 * its raw words in Details.
 */
export const CarryOverCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  useObservable(runtime.projections.environments);
  const admin = runtime.capability(environmentId, "carryOver.run");
  const writable = admin.status === "present";
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const ids = (accounts.value ?? []).filter((account) => account.directory.kind === "adopted").map((account) => account.id).join(" ");
  const listed = useObservable(
    useMemo(
      () => derived(ids.split(" ").filter((id) => id !== "").map((accountId) => runtime.requests.cached(environmentId, "carryOver.inventory", { accountId })), (...answers: CachedAnswer<"carryOver.inventory">[]) => answers),
      [runtime, environmentId, ids],
    ),
  );
  // A re-run can find terminal sessions with no notice: opening the card reads each directory again.
  useEffect(() => {
    for (const accountId of ids.split(" ").filter((id) => id !== "")) runtime.requests.refresh(environmentId, "carryOver.inventory", { accountId });
  }, [runtime, environmentId, ids]);
  const detection = useFollowed(useMemo(() => runtime.capability(environmentId, "stateImport").status === "present" ? runtime.requests.cached(environmentId, "stateImport.detect", {}) : undefined, [runtime, environmentId]));
  const earlierWorkFound = detection?.result !== null && detection?.result !== undefined && (detection.result.dataFolder !== null || detection.result.terminalFolder !== null);
  const bringOverEarlierWork = useBringOverEarlierWork(environmentId);
  const noticeDetails = useNoticeDetails(environmentId, step);
  const [skillsChoice, setSkillsChoice] = useState<boolean | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [reports, setReports] = useState<readonly AccountReport[] | undefined>(undefined);
  const [refusals, setRefusals] = useState<readonly PlainRefusal[]>([]);

  if (step.result?.state === "skipped") {
    return (
      <div data-carry-over-nothing className="flex flex-col gap-1">
        <p className="text-sm text-ink">Nothing to bring over from this computer.</p>
        <p className="text-sm text-ink-muted">You can continue.</p>
      </div>
    );
  }

  const adopted = (accounts.value ?? []).filter((account) => account.directory.kind === "adopted");
  const found: Found[] = adopted.flatMap((account, index) => {
    const result = listed[index]?.result;
    return result !== null && result !== undefined && "accountId" in result ? [{ account, inventory: result }] : [];
  });
  const unread = adopted.flatMap((account, index) => (listed[index]?.error === null || listed[index]?.error === undefined ? [] : [{ account, error: listed[index].error }]));
  const looking = (accounts.value === null && accounts.error === null) || adopted.some((account, index) => listed[index]?.result === null && listed[index].error === null);
  const skills = skillsChoice ?? found.some(({ inventory }) => skillCount(inventory) > 0);
  const targets = step.result?.targets ?? [];
  const retryAccounts = targets.filter((target) => target.action === "import-again" && target.kind === "account").map((target) => target.id);
  const earlierWorkStopped = targets.some((target) => target.action === "import-again" && target.kind === "environment");
  // A retry is of an account brought over before, or of one that failed here: Try again, the one button (§5.3).
  const retry = found.some(({ account, inventory }) => retryAccounts.includes(account.id) && broughtBefore(inventory)) || (reports?.some(({ report }) => report.failed.length > 0) ?? false);
  const firstTime = found.some(({ inventory }) => holdsAnything(inventory) && !broughtBefore(inventory));
  const newChats = found.reduce((sum, { inventory }) => sum + inventory.sessions.new, 0);
  const otherNew = found.reduce((sum, { inventory }) => sum + inventory.memory.new + (skills ? inventory.skills.new : 0), 0);
  const primary = retry ? "Try again" : firstTime || otherNew > 0 ? "Bring them over" : newChats > 0 ? `Bring over ${counted(newChats, "new chat", "new chats")}` : undefined;

  const bringOver = async (accountsToRun: readonly Found[], withEarlierWork: boolean) => {
    setBusy(true);
    setRefusals([]);
    const ran: AccountReport[] = [];
    const refused: PlainRefusal[] = [];
    for (const { account } of accountsToRun) {
      const answer = await adminCall(() => runtime.requests.call(environmentId, "carryOver.run", { commandId: uuidv7(clock.now()), accountId: account.id, dryRun: false, skills }));
      if (!answer.ok) refused.push(plainRefusal(answer.refusal, primary ?? "Bring them over"));
      else if (answer.result !== undefined) ran.push({ label: account.label, report: answer.result });
      runtime.requests.refresh(environmentId, "carryOver.inventory", { accountId: account.id });
    }
    if (withEarlierWork) {
      const answer = await bringOverEarlierWork();
      if (!answer.ok) refused.push(plainRefusal(answer.refusal, "Continue bringing it over"));
    }
    setBusy(false);
    setRefusals(refused);
    setReports(ran.length > 0 ? ran : reports);
  };
  // The earlier work comes over with the first bring-over only: a re-run would apply its window preferences again.
  const bringThemOver = () => void bringOver(found, earlierWorkFound && (firstTime || earlierWorkStopped));
  const checkAgain = () => {
    runtime.requests.refresh(environmentId, "accounts.list", {});
    for (const { account } of unread) runtime.requests.refresh(environmentId, "carryOver.inventory", { accountId: account.id });
    void runtime.setup.check(environmentId, "carry-over");
  };

  return (
    <>
      <StepStatus environmentId={environmentId} step={step} handledActions={["import-again"]} />
      {admin.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={admin}><p className="text-sm text-amber">You can look but not change this. {admin.message}</p></AccessUnavailable>}
      {accounts.error !== null && (
        <SetupNotice
          tone="error"
          title="agent-harness could not look at your past work."
          description="Choose Check again."
          actions={<Button variant="outline" onClick={checkAgain}><RefreshCw aria-hidden="true" />Check again</Button>}
          details={noticeDetails("agent-harness could not look at your past work.", [`${accounts.error.code}: ${accounts.error.message}`])}
        />
      )}
      {unread.map(({ account, error }) => (
        <SetupNotice
          key={account.id}
          tone="error"
          title={`agent-harness could not look at ${account.label}'s past work.`}
          description="Choose Check again."
          actions={<Button variant="outline" onClick={checkAgain}><RefreshCw aria-hidden="true" />Check again</Button>}
          details={noticeDetails(`agent-harness could not look at ${account.label}'s past work.`, [`Folder: ${account.directory.path}`, `${error.code}: ${error.message}`])}
        />
      ))}
      {looking && <p role="status" className="text-sm text-ink-muted">Looking for past work…</p>}
      {found.length > 0 && (
        <div data-carry-over-found className="flex min-w-0 flex-col gap-3">
          {found.map(({ account, inventory }) => (
            <p key={account.id} className="text-sm text-ink">
              {account.label}: {counted(inventory.sessions.total, "past chat", "past chats")}, {counted(inventory.memory.folders, "notes folder", "notes folders")}, {counted(skillCount(inventory), "skill", "skills")}.
            </p>
          ))}
          {found.some(({ inventory }) => skillCount(inventory) > 0) && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" title="Bring over skills too · Tab, Space" checked={skills} disabled={!writable || busy} onChange={(event) => setSkillsChoice(event.target.checked)} />
              Bring over skills too
            </label>
          )}
          {primary !== undefined && (
            <Button variant="default" title={`${primary} · Tab, Enter or Space`} className="self-start" disabled={!writable || busy} onClick={bringThemOver}>
              <Download aria-hidden="true" />{primary}
            </Button>
          )}
          {primary === undefined && (reports !== undefined || found.some(({ inventory }) => broughtBefore(inventory))) && stepLine(step, runtime.environmentNow(environmentId)) !== ALREADY_HERE && (
            <p role="status" className="text-sm text-ink-muted">{ALREADY_HERE}</p>
          )}
          <ComingOver found={found} />
          <NotComingOver />
        </div>
      )}
      {earlierWorkStopped && earlierWorkFound && (
        <Button variant="outline" title="Continue bringing it over · Tab, Enter or Space" className="self-start" disabled={busy || runtime.capability(environmentId, "stateImport.run").status === "absent"} onClick={() => void bringOver([], true)}>
          <Download aria-hidden="true" />Continue bringing it over
        </Button>
      )}
      {refusals.map((refusal) => <SetupNotice key={refusal.line} tone="error" title={refusal.line} details={noticeDetails(refusal.line, refusal.details)} />)}
      {reports !== undefined && <ImportReport reports={reports} details={noticeDetails} />}
      {found.flatMap(({ inventory }) => inventory.skills.offered.map((offer) => <CheckoutOffer key={offer.from} environmentId={environmentId} offer={offer} details={noticeDetails} />))}
      {found.flatMap(({ inventory }) =>
        inventory.memory.unmappable.map((folder) => <MemoryAssignment key={`${inventory.accountId}/${folder.folder}`} environmentId={environmentId} accountId={inventory.accountId} folder={folder} details={noticeDetails} />),
      )}
      <StateImportSection environmentId={environmentId} needsRepair={false} />
    </>
  );
};
