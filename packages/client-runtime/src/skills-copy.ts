import type { AccountRecord, OwnedInstruction, ParamsOf, SkillChoice, SkillSource } from "@agent-harness/contracts";
import { copyOutcome, copyToEach, type CommandAnswer, type CopyReport } from "./copies.js";
import type { CapabilityAnswer } from "./capabilities.js";
import { uuidv7 } from "./ids.js";
import type { Clock } from "./platform.js";
import { identityKey } from "./projections/accounts.js";
import type { RequestFailure, Requests } from "./requests.js";

/** The state explicitly chosen for a bulk copy; own-directory files are never part of it. */
export interface SkillsCopySelection {
  readonly sources?: boolean;
  readonly choices?: boolean;
  readonly instructionIds?: readonly string[];
  /** Replays the source's dismissals; leaves unrelated target dismissals in place. */
  readonly dismissed?: boolean;
}

export type SkillsCopyItem = {
  readonly kind: "source" | "choice" | "instruction" | "dismissed";
  readonly id: string;
  readonly accountId?: string;
  readonly choiceKind?: SkillChoice["kind"];
};
export type SkillsCopyItemReport = SkillsCopyItem & (
  | { readonly status: "copied" }
  | { readonly status: "skipped"; readonly reason: "account_absent" | "duplicate" }
  | { readonly status: "refused"; readonly error: RequestFailure }
);

export interface SkillsCopies {
  /**
   * Replays the selected state through direct admin requests on each chosen
   * target. Uses copyTargets' admin connections and CopyReport's per-target
   * outcome (#320); item reports retain partial successes and refusals.
   * A target reported copied has processed the request: inspect its item
   * statuses for skips and refusals, including a partly applied instruction.
   * Account ids map by identity, never by label or id. No request carries
   * another environment's identity, and nothing waits in the outbox.
   */
  copyToEnvironments(fromEnvironmentId: string, selection: SkillsCopySelection, toEnvironmentIds: readonly string[]): Promise<readonly CopyReport<readonly SkillsCopyItemReport[]>[]>;
}

interface SkillsCopyHost {
  readonly clock: Clock;
  readonly call: Requests["call"];
  capability(environmentId: string, method: "skills.setEnabled"): CapabilityAnswer;
  name(environmentId: string): string | null;
  targetIds(fromEnvironmentId: string): readonly string[];
}

type CopyMethod = "skills.sources.add" | "skills.setEnabled" | "skills.setAlwaysOn" | "instructions.create" | "instructions.edit" | "instructions.setScope" | "instructions.setEnabled" | "instructions.move" | "instructions.dismissSuggestion";

export const createSkillsCopies = (host: SkillsCopyHost): SkillsCopies => ({
  async copyToEnvironments(fromEnvironmentId, selection, toEnvironmentIds) {
    const environmentName = host.name(fromEnvironmentId);
    const from = environmentName === null ? null : { environmentId: fromEnvironmentId, environmentName };
    const targets = new Set(host.targetIds(fromEnvironmentId));
    // Read the source only once, lazily: an unreachable target needs no source read.
    const load = async () => {
      let choices: readonly SkillChoice[] = [];
      let sources: readonly SkillSource[] = [];
      let instructions: readonly OwnedInstruction[] = [];
      let dismissed: readonly string[] = [];
      if (selection.choices || selection.sources) {
        const answer = await host.call(fromEnvironmentId, "skills.get", {});
        if (!answer.ok) return answer;
        if (selection.choices) choices = answer.result.choices;
        if (selection.sources) sources = answer.result.sources;
      }
      if (selection.instructionIds?.length || selection.dismissed) {
        const answer = await host.call(fromEnvironmentId, "instructions.list", {});
        if (!answer.ok) return answer;
        instructions = answer.result.instructions;
        if (selection.dismissed) dismissed = answer.result.dismissed;
      }
      const needsAccounts = choices.some((choice) => choice.accountId !== null)
        || instructions.some((instruction) => selection.instructionIds?.includes(instruction.id) && instruction.scope !== "all");
      let accounts: readonly AccountRecord[] = [];
      if (needsAccounts) {
        const answer = await host.call(fromEnvironmentId, "accounts.list", {});
        if (!answer.ok) return answer;
        accounts = answer.result.accounts;
      }
      return { ok: true, sources, choices, instructions, dismissed, accounts, needsAccounts } as const;
    };
    let loaded: ReturnType<typeof load> | undefined;
    return copyToEach(from, toEnvironmentIds, async (environmentId) => {
      if (!targets.has(environmentId)) return { status: "refused", error: { code: "scope", message: "Choose another enabled environment with an admin connection." } };
      const capability = host.capability(environmentId, "skills.setEnabled");
      if (capability.status === "absent") return { status: "refused", error: { code: capability.reason === "not-ready" ? "unreachable" : capability.reason, message: capability.message } };
      const source = await (loaded ??= load());
      if (!source.ok) return { status: "refused", error: source.error };
      let accounts: readonly AccountRecord[] = [];
      if (source.needsAccounts) {
        const answer = await host.call(environmentId, "accounts.list", {});
        if (!answer.ok) return { status: "refused", error: answer.error };
        accounts = answer.result.accounts;
      }
      const mapped = accountMapping(source.accounts, accounts);
      const reports: SkillsCopyItemReport[] = [];
      const send = async <N extends CopyMethod>(method: N, params: Omit<ParamsOf<N>, "commandId">): Promise<RequestFailure | null> => {
        // CopyMethod contains only commands; requests.call has validated the receipt.
        const answer = await host.call(environmentId, method, { ...params, commandId: uuidv7(host.clock.now()) } as ParamsOf<N>);
        const outcome = copyOutcome(answer as CommandAnswer<unknown>, () => true);
        return outcome.status === "refused" ? outcome.error : null;
      };
      const report = (item: SkillsCopyItem, error: RequestFailure | null) => reports.push(error === null ? { ...item, status: "copied" } : { ...item, status: "refused", error });
      for (const row of source.sources) {
        const item: SkillsCopyItem = { kind: "source", id: row.id };
        const error = await send("skills.sources.add", { url: row.url, folder: row.folder, follow: row.follow });
        if (error?.code === "conflict" && error.data?.["reason"] === "duplicate") reports.push({ ...item, status: "skipped", reason: "duplicate" });
        else report(item, error);
      }
      for (const choice of source.choices) {
        const item: SkillsCopyItem = { kind: "choice", choiceKind: choice.kind, id: choice.name, ...(choice.accountId !== null && { accountId: choice.accountId }) };
        const accountId = choice.accountId === null ? null : mapped.get(choice.accountId);
        if (accountId === undefined) {
          reports.push({ ...item, status: "skipped", reason: "account_absent" });
          continue;
        }
        report(item, choice.kind === "enabled"
          ? await send("skills.setEnabled", { name: choice.name, accountId, enabled: choice.enabled })
          : await send("skills.setAlwaysOn", { name: choice.name, accountId: accountId!, on: choice.on }));
      }
      if (selection.instructionIds?.length) {
        const answer = await host.call(environmentId, "instructions.list", {});
        if (!answer.ok) {
          for (const id of new Set(selection.instructionIds)) report({ kind: "instruction", id }, answer.error);
        } else {
          const held = new Set(answer.result.instructions.map((instruction) => instruction.id));
          for (const id of new Set(selection.instructionIds)) {
            const item: SkillsCopyItem = { kind: "instruction", id };
            const instruction = source.instructions.find((instruction) => instruction.id === id);
            if (instruction === undefined) {
              report(item, { code: "not_found", message: "The source holds no owned instruction with this id.", data: { kind: "instruction", instructionId: id } });
              continue;
            }
            const scope = instruction.scope === "all" ? "all" : [...new Set(instruction.scope.flatMap((accountId) => {
              const there = mapped.get(accountId);
              if (there === undefined) reports.push({ ...item, accountId, status: "skipped", reason: "account_absent" });
              return there === undefined ? [] : [there];
            }))];
            if (scope !== "all" && scope.length === 0) continue;
            let error: RequestFailure | null;
            if (!held.has(id)) {
              error = await send("instructions.create", {
                id, title: instruction.title, body: instruction.body,
                ...(instruction.origin !== null && { origin: instruction.origin }),
                scope, enabled: instruction.enabled, position: instruction.position,
              });
            } else {
              error = await send("instructions.edit", { instructionId: id, title: instruction.title, body: instruction.body });
              if (error === null) error = await send("instructions.setScope", { instructionId: id, scope });
              if (error === null) error = await send("instructions.setEnabled", { instructionId: id, enabled: instruction.enabled });
              if (error === null) error = await send("instructions.move", { instructionId: id, position: instruction.position });
            }
            report(item, error);
          }
        }
      }
      for (const id of source.dismissed) report({ kind: "dismissed", id }, await send("instructions.dismissSuggestion", { catalogueId: id }));
      return { status: "copied", result: reports };
    });
  },
});

const accountMapping = (source: readonly AccountRecord[], target: readonly AccountRecord[]): ReadonlyMap<string, string> => {
  const there = new Map(target.flatMap((account) => account.identity === null ? [] : [[identityKey(account.identity), account.id] as const]));
  return new Map(source.flatMap((account) => {
    const id = account.identity === null ? undefined : there.get(identityKey(account.identity));
    return id === undefined ? [] : [[account.id, id] as const];
  }));
};
