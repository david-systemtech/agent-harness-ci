import { memoryBankHealth, STEP_REGISTRY, type BankRecord, type SetupAction, type SetupTarget } from "@agent-harness/contracts";
import type { SetupStepView } from "@agent-harness/client-runtime";

/** A stopped conversation's targets arrive as session, then Write it myself and Start over on its subject (setup/check.ts). */
const stoppedForBank = (targets: readonly SetupTarget[], bankId: string): SetupTarget[] => {
  const own: SetupTarget[] = [];
  let session: SetupTarget | undefined;
  for (const target of targets) {
    if (target.kind === "session" && target.action === "try-again") session = target;
    if (target.kind !== "bank" || target.id !== bankId || (target.action !== "write-it-myself" && target.action !== "start-over")) continue;
    if (session !== undefined && !own.includes(session)) own.push(session);
    own.push(target);
  }
  return own;
};

/** Project verified bank facts, never the step's aggregate summary, onto one subject's card. */
export const stepForBank = (step: SetupStepView, bank: BankRecord): SetupStepView => {
  const result = step.result;
  if (result === null) return step;
  const record = { ...bank, host: bank.location.kind === "remote" ? new URL(bank.location.origin).host : null, copiedFrom: bank.copiedFrom?.environmentName ?? null };
  const checks = STEP_REGISTRY.find((entry) => entry.id === "memory-bank")?.stateChecks ?? [];
  const findings = checks.flatMap((check) => {
    const answer = memoryBankHealth[check.id as keyof typeof memoryBankHealth]([record]);
    return answer === true ? [] : [{ check, answer }];
  });
  const failures = findings.filter(({ answer }) => !answer.holds);
  const stopped = failures.length === 0 ? [] : stoppedForBank(result.targets ?? [], bank.id);
  const actions: SetupAction[] = [...new Set([
    ...stopped.map((target) => target.action),
    ...(failures.length === 0 ? ["revise" as const] : failures.flatMap(({ check }) => check.actions)),
  ])];
  const targets: SetupTarget[] = [
    ...stopped,
    ...(failures.length === 0 ? [{ action: "revise" as const, kind: "bank" as const, id: bank.id, label: bank.name }] : failures.flatMap(({ answer }) => answer.targets ?? [])),
  ].map((target) => result.targets?.find((given) => given.action === target.action && given.kind === target.kind && given.id === target.id) ?? target);
  const details = findings.flatMap(({ answer }) => answer.details ?? []);
  // Only freshness belongs to the shared check. Its failures, times and last-good summary name all banks.
  return { ...step, result: {
    step: result.step, checkedAt: result.checkedAt, asked: result.asked, ageMs: result.ageMs,
    olderThanCadence: result.olderThanCadence, stale: result.stale,
    state: failures.length === 0 ? "done" : "needs-attention",
    reason: [
      ...(stopped.length === 0 ? [] : ["The describing conversation stopped."]),
      ...(failures.length === 0 ? ["Your notebook is ready.", ...findings.map(({ answer }) => answer.reason)] : failures.map(({ answer }) => answer.reason)),
    ].join(" "),
    failing: failures.map(({ check }) => check.id), actions, targets,
    ...(details.length > 0 && { details }),
  } };
};
