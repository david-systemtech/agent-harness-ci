import type { AutoAnswer, AutoAnswerRequest, PromptAutoAnswer } from "../adapter/seams.js";

/**
 * The broker's automatic rules (#131; permissions spec, "Attended and
 * unattended runs; the unattended default", the prompt state machine; ADR
 * 0006), behind #130's `PromptAutoAnswer` seam: pure, the run's attendance
 * and mode and the prompt's kind in, a rule's answer or null out. A rule's
 * answer is recorded as the prompt's `prompt.answered` in the transaction of
 * its `prompt.opened` (the host's broker), so the prompt never parks and no
 * notice is raised, and the adapter is handed it as an ordinary deny with a
 * message the model reads: the deny-and-continue rule, never an interrupt.
 *
 * - On an unattended run nobody can answer: a prompt of any kind is denied
 *   at once (`unattended`), a question with the unattended answer.
 * - In bypassPermissions nothing waits (ADR 0006): a residual `permission`
 *   prompt the provider still raises is denied at once (`bypass`), on an
 *   attended run too. A question, a plan or a denylist prompt still parks
 *   for the person present, who may allow a denylisted call.
 * - Anything else parks for a person.
 *
 * The `reviewer` rule (Codex's automatic review) is milestone 2's; no Claude
 * prompt is answered by one.
 */

/** What the model reads when a prompt of an unattended run is denied (permissions spec, fixed there). */
export const UNATTENDED_DENIAL = "Denied: nobody is present to approve this. Continue without it and say what you could not do.";

/** What the model reads when it asks its user a question on an unattended run (permissions spec, fixed there). */
export const UNATTENDED_ANSWER = "nobody is present; proceed with your best judgement";

/**
 * What the model reads when a residual permission prompt is denied in
 * bypassPermissions: a chosen wording, since a person may be present on an
 * attended run, with the unattended denial's instruction to carry on.
 */
export const BYPASS_DENIAL = "Denied: this run is in bypassPermissions, which never waits for an approval. Continue without it and say what you could not do.";

const deny = (auto: AutoAnswer["auto"], message: string): AutoAnswer => ({ auto, decision: { decision: "deny", message } });

export const autoAnswer: PromptAutoAnswer = ({ kind, attended, mode }: AutoAnswerRequest): AutoAnswer | null => {
  if (!attended) return deny("unattended", kind === "question" ? UNATTENDED_ANSWER : UNATTENDED_DENIAL);
  if (mode === "bypassPermissions" && kind === "permission") return deny("bypass", BYPASS_DENIAL);
  return null;
};
