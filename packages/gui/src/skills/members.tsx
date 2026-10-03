import type { SkillReadiness, SkillsView, SkillsViewMember } from "@agent-harness/contracts";
import { Sparkles, Power, Repeat, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, DialogContent, Switch, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { SkillButton, useSkillVerb } from "./skill-verb.js";

/** Every member, including invalid and shadowed ones, is drawn from skills.get; choices are keyed by name. */
export const MemberCard = ({
  environmentId,
  member,
  skills,
  readiness,
  say,
}: {
  readonly environmentId: string;
  readonly member: SkillsViewMember;
  readonly skills: SkillsView;
  readonly readiness: SkillReadiness | undefined;
  readonly say: (line: string) => void;
}) => {
  const runtime = useRuntime();
  const { send, sending, commandId, refusal, clearRefusal } = useSkillVerb(say);
  const [removing, setRemoving] = useState(false);
  const name = member.name;
  const invalid = name === null || member.problems.length > 0;
  const enabledCapability = runtime.capability(environmentId, "skills.setEnabled");
  const alwaysCapability = runtime.capability(environmentId, "skills.setAlwaysOn");
  const environmentChoice = skills.choices.find((choice) => choice.kind === "enabled" && choice.name === name && choice.accountId === null);
  const environmentEnabled = environmentChoice?.kind === "enabled" ? environmentChoice.enabled : true;
  return (
    <section aria-label={name ?? member.path} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel px-3 py-2.5">
      <h3 className="flex items-center gap-2 text-xs font-semibold"><Sparkles aria-hidden="true" className="size-4 text-ink-muted" /><span className="font-mono">{member.userInvocable && name !== null ? `/${name}` : name ?? member.path}</span></h3>
      <p className="text-2xs text-ink-muted">{member.description}</p>
      <p className="text-2xs text-ink-muted">
        {member.layer.kind}: {member.path} · {member.invocation}
        {!member.userInvocable && " · Not in the slash menu"}
      </p>
      {member.origin !== null && (
        <p className="text-2xs text-ink-muted">
          {member.origin.repository} — {member.origin.path}
        </p>
      )}
      <p className="flex items-center gap-1 text-2xs text-ink-faint"><ShieldCheck aria-hidden="true" className="size-3" />Licence: {member.origin?.kind === "manifest" ? member.origin.licence ?? "Not supplied" : "Not supplied"}</p>
      {member.shadowedBy !== null && (
        <p className="text-sm text-amber">
          Shadowed by {member.shadowedBy.layer.kind}: {member.shadowedBy.path}
        </p>
      )}
      {member.problems.map((problem, index) => (
        <p key={index} className="text-sm text-amber">
          {problem.message}
        </p>
      ))}
      {member.warnings.map((warning, index) => (
        <p key={index} className="text-sm text-amber">
          {warning.message}
        </p>
      ))}
      {readiness !== undefined && (
        <div className="text-2xs text-ink-muted">
          <p>{readiness.state === "ready" ? "Ready" : readiness.state === "unsupported" ? "Unsupported" : "Setup needed"}</p>
          {readiness.state !== "ready" && (
            <>
              {readiness.why !== null && <p>{readiness.why}</p>}
              {readiness.failing.map((failure, index) => (
                <p key={index}>{failure.message}</p>
              ))}
              {readiness.fix !== null && <p>Fix: {readiness.fix}</p>}
            </>
          )}
        </div>
      )}
      {enabledCapability.status === "absent" && <p className="text-sm text-ink-faint">{enabledCapability.message}</p>}
      {alwaysCapability.status === "absent" && <p className="text-sm text-ink-faint">{alwaysCapability.message}</p>}
      {invalid && <p className="text-sm text-ink-faint">Invalid members cannot be enabled or made always-on.</p>}
      <label className="flex items-center gap-2 text-sm">
        <Tooltip content="Enabled on this environment · Space"><Switch
          aria-label={`Enabled ${name ?? member.path} on this environment`}
          disabled={invalid || sending || enabledCapability.status === "absent"}
          checked={environmentEnabled}
          onCheckedChange={(enabled) => {
            if (name !== null)
              void send(
                () => runtime.requests.call(environmentId, "skills.setEnabled", { commandId: commandId(), name, accountId: null, enabled }),
                enabled ? "Skill enabled on this environment." : "Skill disabled on this environment.",
              );
          }}
        /></Tooltip>
        <Power aria-hidden="true" className="size-3.5" />Enabled on this environment
      </label>
      <p className="text-2xs text-ink-muted">
        {member.size} characters · approximately {member.tokens} tokens on every prompt. A disabled or shadowed member is never appended.
      </p>
      {skills.accounts.length === 0 && <p className="text-sm text-ink-faint">No account is available for account choices.</p>}
      {skills.accounts.map((account) => {
        const enabledChoice = skills.choices.find((choice) => choice.kind === "enabled" && choice.name === name && choice.accountId === account.accountId);
        const alwaysChoice = skills.choices.find((choice) => choice.kind === "always-on" && choice.name === name && choice.accountId === account.accountId);
        const accountEnabled = enabledChoice?.kind === "enabled" ? enabledChoice.enabled : true;
        const on = alwaysChoice?.kind === "always-on" ? alwaysChoice.on : false;
        return (
          <div key={account.accountId} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Tooltip content={`Enabled on ${account.accountId} · Space`}><Switch
                aria-label={`Enabled ${name ?? member.path} on ${account.accountId}`}
                disabled={invalid || sending || enabledCapability.status === "absent" || !environmentEnabled}
                checked={accountEnabled}
                onCheckedChange={(enabled) => {
                  if (name !== null)
                    void send(
                      () => runtime.requests.call(environmentId, "skills.setEnabled", { commandId: commandId(), name, accountId: account.accountId, enabled }),
                      "Account choice saved.",
                    );
                }}
              /></Tooltip>
              <Power aria-hidden="true" className="size-3.5" />Enabled on {account.accountId}
            </label>
            {!environmentEnabled && <p className="text-xs text-ink-faint">The environment's disabled choice takes precedence.</p>}
            <label className="flex items-center gap-2 text-sm">
              <Tooltip content={`Every prompt on ${account.accountId} · Space`}><Switch
                aria-label={`Every prompt ${name ?? member.path} on ${account.accountId}`}
                disabled={invalid || sending || alwaysCapability.status === "absent" || account.channel === "none"}
                checked={on}
                onCheckedChange={(on) => {
                  if (name !== null)
                    void send(
                      () => runtime.requests.call(environmentId, "skills.setAlwaysOn", { commandId: commandId(), name, accountId: account.accountId, on }),
                      "Always-on choice saved.",
                    );
                }}
              /></Tooltip>
              <Repeat aria-hidden="true" className="size-3.5" />Every prompt on {account.accountId}
              {account.accountId === skills.accountId && " (viewed account)"}
            </label>
            {account.channel === "none" && <p className="text-xs text-ink-faint">{account.reason ?? "This account has no instruction channel."}</p>}
          </div>
        );
      })}
      {member.layer.kind === "own" && (
        <SkillButton
          environmentId={environmentId}
          method="skills.own.remove"
          reason={
            name === null
              ? "This member has no valid name to remove."
              : member.shadowedBy?.layer.kind === "own"
                ? "Another own member wins this name; remove that member first."
                : undefined
          }
          busy={sending}
          onClick={() => {
            clearRefusal();
            setRemoving(true);
          }}
        >
          Remove own skill
        </SkillButton>
      )}
      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent title={`Remove own skill ${name}`} description="Move the skill to the environment's trash for thirty days.">
          {refusal !== undefined && (
            <p role="status" className="text-sm text-amber">
              {refusal}
            </p>
          )}
          <SkillButton
            environmentId={environmentId}
            method="skills.own.remove"
            busy={sending}
            onClick={() => {
              if (name !== null)
                void send(() => runtime.requests.call(environmentId, "skills.own.remove", { commandId: commandId(), name }), "Own skill removed.").then(
                  (ok) => {
                    if (ok) setRemoving(false);
                  },
                );
            }}
          >
            Confirm remove skill
          </SkillButton>
          <Tooltip content="Cancel · Escape"><Button onClick={() => setRemoving(false)}><X aria-hidden="true" />Cancel</Button></Tooltip>
        </DialogContent>
      </Dialog>
    </section>
  );
};
