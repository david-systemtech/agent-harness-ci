import type { AccountRecord, RunPolicy, RunSummary } from "@agent-harness/contracts";
import { endWords, formatTokens, formatUsd } from "../transcript/format.js";
import { effortName, identityWords, modelDisplayName, spendOf } from "./words.js";

export const NO_RUN_YET = "No run yet: the session's first message starts one.";
const POLICY_NOT_HEARD = "not heard by this client: the run's policy was resolved before it caught up";

/** The latest run's facts, in the same words in every client, from its own record and resolved policy. */
export const runInfoFacts = (run: RunSummary, policy: RunPolicy | undefined, account: AccountRecord | undefined): readonly { readonly term: string; readonly words: string }[] => {
  const spend = spendOf(run.usage);
  return [
    { term: "Started by", words: policy ? startedBy(policy) : run.origin },
    { term: "Account", words: account ? `${account.label} (${identityWords(account)})` : run.accountId },
    { term: "Model", words: modelDisplayName(run.model) },
    { term: "Effort", words: run.effort !== null ? effortName(run.effort) : "the model's own" },
    { term: "Mode", words: modeWords(run, policy) },
    { term: "Containment", words: policy ? containmentWords(policy) : POLICY_NOT_HEARD },
    { term: "Tokens", words: spend ? `${formatTokens(spend.tokens)} (${usageWords(run)})` : "none reported yet" },
    { term: "Cost", words: spend?.costUsd != null ? formatUsd(spend.costUsd) : "not reported" },
    { term: "Ending", words: endingWords(run) },
  ];
};

/** Who started the run, and whether a person was there. */
const startedBy = (policy: RunPolicy): string => {
  const who = policy.actorName !== null ? `${policy.actorKind} ${policy.actorName}` : policy.actorKind;
  return `${who}, ${policy.attended ? "attended" : "unattended"}${policy.unattendedDefaultApplied ? " (the unattended default mode)" : ""}`;
};

/** The mode the run got, and the clamp when it was lowered: the resolved policy's reason and ceiling when heard, the run's own record otherwise. */
const modeWords = (run: RunSummary, policy: RunPolicy | undefined): string => {
  if (policy) {
    const { mode } = policy;
    if (!mode.clamped) return `${mode.effective}${mode.requested === null ? " (the default)" : ""}, under the ceiling ${mode.ceiling}`;
    return mode.clampReason === "unavailable"
      ? `${mode.effective}, clamped from ${mode.requested ?? "the default"}: its account cannot use it`
      : `${mode.effective}, clamped from ${mode.requested ?? "the default"} to the ceiling ${mode.ceiling}`;
  }
  return run.mode.clamped ? `${run.mode.effective}, clamped from ${run.mode.requested ?? "the default"}` : run.mode.effective;
};

/** The containment the run got, what enforces it, and why it is not the level asked for when it is not. */
const containmentWords = ({ containment }: RunPolicy): string => {
  const asked = containment.requested === null ? "the environment's default" : `asked for ${containment.requested}`;
  const by = containment.mechanism === null ? "" : `, enforced by ${containment.mechanism}`;
  return `${containment.effective} (${asked})${by}${containment.reason !== null ? `: ${containment.reason}` : ""}`;
};

/** The run's tokens by kind: input, cache reads and writes, output. */
const usageWords = (run: RunSummary): string => {
  const sum = (pick: (model: NonNullable<RunSummary["usage"]>[number]) => number) => (run.usage ?? []).reduce((total, model) => total + pick(model), 0);
  return `${formatTokens(sum((m) => m.inputTokens))} in, ${formatTokens(sum((m) => m.cacheReadTokens))} cache read, ${formatTokens(sum((m) => m.cacheWriteTokens))} cache write, ${formatTokens(sum((m) => m.outputTokens))} out`;
};

/** How the run ended: still running, completed, or its end in words with the error it ended on. */
const endingWords = (run: RunSummary): string => {
  if (run.state === "running") return "still running";
  const words = endWords(run);
  return run.error !== null ? `${words}: ${run.error.message}` : words;
};
