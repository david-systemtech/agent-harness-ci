import { AccessUnavailable } from "../connections/limited-access.js";
import { adminCall, uuidv7 } from "@agent-harness/client-runtime";
import type { AccountRecord, CarryOverInventory, CarryOverReport } from "@agent-harness/contracts";
import { Download, RefreshCw } from "lucide-react";
import { CountGrid } from "./count-grid.js";
import { useEffect, useMemo, useState } from "react";
import type { StepCardProps } from "../setup/cards.js";
import { StepStatus } from "../setup/step-status.js";
import { Button } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";
import { CheckoutOffer } from "./checkout-offer.js";
import { ImportReport } from "./import-report.js";
import { MemoryAssignment } from "./memory-assignment.js";
import { StateImportSection } from "./state-import-section.js";

/** Carry over's adopted accounts, each with its directory's inventory and one import (ADR 0021). */
export const CarryOverCard = ({ environmentId, step }: StepCardProps) => {
  const runtime = useRuntime();
  useObservable(runtime.projections.environments);
  const admin = runtime.capability(environmentId, "carryOver.run");
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(environmentId), [runtime, environmentId]));
  const retryTargets = (step.result?.targets ?? []).filter((target) => target.action === "import-again");
  const mayRetry = (accountId: string) =>
    step.result?.actions.includes("import-again") === true &&
    (retryTargets.length === 0 || retryTargets.some((target) => target.kind === "account" && target.id === accountId));
  if (step.result?.state === "skipped") return <StepStatus environmentId={environmentId} step={step} />;
  return (
    <>
      <StepStatus environmentId={environmentId} step={step} handledActions={["import-again"]} />
      {admin.status === "absent" && <AccessUnavailable environmentId={environmentId} answer={admin}><p className="text-sm text-amber">Read-only: {admin.message}</p></AccessUnavailable>}
      {accounts.error !== null && <p className="text-sm text-ink-muted">The accounts could not be read: {accounts.error.message}</p>}
      {accounts.value
        ?.filter((account) => account.directory.kind === "adopted")
        .map((account) => (
          <AccountCarryOver
            key={`${environmentId}/${account.id}`}
            environmentId={environmentId}
            account={account}
            retry={mayRetry(account.id)}
          />
        ))}
      <StateImportSection environmentId={environmentId} />
      <p className="text-sm text-ink-muted">
        Not carried from your Claude Code directory: hooks, personal MCP servers, permission rules and the approvals you gave the CLI, your
        settings (model, theme, status line, key bindings), plugins and marketplaces, subagents, prompt history and trust decisions. Your
        terminal claude keeps using all of them. Repository instructions and hooks load in the harness once you trust the repository; MCP
        servers and permissions are set per environment in Set up.
      </p>
      <p className="text-sm text-ink-muted">The harness copy of the skills is now the one to edit.</p>
    </>
  );
};

const AccountCarryOver = ({
  environmentId,
  account,
  retry,
}: {
  readonly environmentId: string;
  readonly account: AccountRecord;
  readonly retry: boolean;
}) => {
  const runtime = useRuntime();
  const listed = useObservable(
    useMemo(
      () =>
        runtime.requests.cached(environmentId, "carryOver.inventory", {
          accountId: account.id,
        }),
      [runtime, environmentId, account.id],
    ),
  );
  // A re-run can find terminal sessions with no notice: opening the card reads the directory again.
  useEffect(() => {
    runtime.requests.refresh(environmentId, "carryOver.inventory", { accountId: account.id });
  }, [runtime, environmentId, account.id]);
  return (
    <section aria-label={account.label} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-4">
      <h3 className="text-sm font-medium text-ink">{account.label}</h3>
      <p className="break-all font-mono text-xs text-ink-muted">{account.directory.path}</p>
      {listed.error !== null && <p className="text-sm text-ink-muted">The inventory could not be read: {listed.error.message}</p>}
      {listed.result !== null && "accountId" in listed.result && (
        <AccountInventory
          key={account.id}
          environmentId={environmentId}
          inventory={listed.result}
          retry={retry ? account.label : undefined}
        />
      )}
    </section>
  );
};

const AccountInventory = ({
  environmentId,
  inventory,
  retry,
}: {
  readonly environmentId: string;
  readonly inventory: CarryOverInventory;
  readonly retry: string | undefined;
}) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [skillsChoice, setSkillsChoice] = useState<boolean | undefined>(undefined);
  const skills = skillsChoice ?? inventory.skills.skills + inventory.skills.commands > 0;
  const [report, setReport] = useState<CarryOverReport | undefined>(undefined);
  const [line, say] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const writable = runtime.capability(environmentId, "carryOver.run").status === "present";
  const run = async () => {
    setBusy(true);
    say(undefined);
    const answer = await adminCall(() =>
      runtime.requests.call(environmentId, "carryOver.run", {
        commandId: uuidv7(clock.now()),
        accountId: inventory.accountId,
        dryRun: false,
        skills,
      }),
    );
    setBusy(false);
    if (!answer.ok) return say(`Not imported: ${answer.line}`);
    setReport(answer.result);
    runtime.requests.refresh(environmentId, "carryOver.inventory", {
      accountId: inventory.accountId,
    });
  };
  const { sessions, memory, doesNotCarry } = inventory;
  const imported = report !== undefined || sessions.new < sessions.total;
  return (
    <>
      <CountGrid label="Sessions" rows={[["Sessions", sessions.total], ["Archived", sessions.archived], ["Missing directory", sessions.missingDirectory], ["New sessions", sessions.new]]} />
      <CountGrid label="Memory" rows={[["Memory folders", memory.folders], ["Repositories", memory.repositories], ["Unmappable folders", memory.unmappable.length]]} />
      <CountGrid label="Skills and commands" rows={[["Skills", inventory.skills.skills], ["Commands", inventory.skills.commands], ["Checkouts offered", inventory.skills.offered.length], ["Invalid", inventory.skills.invalid]]} />
      <CountGrid label="Not carried" rows={[["Agents", inventory.notCarried.filter((item) => item.kind === "subagent").length], ["Plugins", inventory.notCarried.filter((item) => item.kind === "plugin").length], ["Hooks", doesNotCarry.hooks], ["Personal MCP servers", doesNotCarry.mcpServers], ["Permission rules", doesNotCarry.permissionRules]]} />
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" title="Copy skills and commands · Tab, Space" checked={skills} disabled={!writable || busy} onChange={(event) => setSkillsChoice(event.target.checked)} />
        Copy skills and commands
      </label>
      <Button variant="default" title="Import · Tab, Enter or Space" className="self-start" disabled={!writable || busy} onClick={() => void run()}>
        <Download aria-hidden="true" />{imported && sessions.new > 0 ? `Import ${sessions.new} new sessions` : "Import"}
      </Button>
      {retry !== undefined && (
        <Button variant="outline" title={`Import again: ${retry} · Tab, Enter or Space`} className="self-start" disabled={!writable || busy} onClick={() => void run()}>
          <RefreshCw aria-hidden="true" />Import again: {retry}
        </Button>
      )}
      {imported && sessions.new === 0 && <p className="text-sm text-ink-muted">No new sessions.</p>}
      {inventory.skills.offered.map((offer) => (
        <CheckoutOffer key={offer.from} environmentId={environmentId} offer={offer} />
      ))}
      {memory.unmappable.map((folder) => (
        <MemoryAssignment key={folder.folder} environmentId={environmentId} accountId={inventory.accountId} folder={folder} />
      ))}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
      {report !== undefined && <ImportReport report={report} />}
    </>
  );
};
