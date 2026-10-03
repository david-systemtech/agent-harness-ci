import type { SkillsView } from "@agent-harness/contracts";
import { Sparkles } from "lucide-react";

/** Name-keyed choices outlive a removed source; draw them without inventing a member. */
export const MissingSkillChoices = ({ skills }: { readonly skills: SkillsView }) => {
  const names = [...new Set(skills.choices.map((choice) => choice.name))].filter((name) => !skills.members.some((member) => member.name === name));
  return names.map((name) => <section key={name} aria-label={`Missing skill ${name}`} className="flex flex-col gap-1 rounded-lg border border-hairline bg-panel px-3 py-2.5">
    <h3 className="flex items-center gap-2 text-xs font-medium"><Sparkles aria-hidden="true" className="size-4 text-ink-faint" /><span className="font-mono">/{name}</span><span className="text-2xs text-amber">Missing</span></h3>
    <p className="text-2xs text-ink-muted">Saved choices apply when this skill is available again.</p>
    {skills.choices.filter((choice) => choice.name === name).map((choice) => <p key={`${choice.kind}/${choice.accountId}`} className="text-2xs text-ink-faint">
      {choice.accountId ?? "This environment"}: {choice.kind === "enabled" ? `Enabled ${choice.enabled ? "on" : "off"}` : `Every prompt ${choice.on ? "on" : "off"}`}
    </p>)}
  </section>);
};
