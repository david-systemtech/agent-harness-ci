import { hostOf, type JsonObject, type OneTimeAllowance, type PageArgs, type PageCallOf, type PageDriver, type PageResult, type PageVerb } from "@agent-harness/contracts";
import type { HostToolCall, ToolGate } from "../adapter/contract.js";
import { readCallPrompt } from "../permissions/prompts-store.js";
import type { Reader } from "../sessions/session-tables.js";

/** A person's allowance, scoped to the live run and the provider's call id. */
export const browserAllowance = (reader: Reader, runId: string, call: HostToolCall): OneTimeAllowance | undefined => {
  if (call.toolCallId === null) return undefined;
  const record = readCallPrompt(reader, runId, call.toolCallId, "denylist");
  if (record?.prompt.kind !== "denylist" || record.answer?.decision !== "allow" || typeof record.answer.decidedBy !== "string") return undefined;
  const match = record.prompt.denylist?.find((entry) => entry.section === "browserDomains" || entry.section === "hosts");
  const host = match === undefined ? null : hostOf(match.matched);
  return host === null ? undefined : { host };
};

/** The gate and allowance of the run live when the verb started. */
export interface BrowserCallPolicy {
  readonly gate: ToolGate | null | undefined;
  readonly environmentId: string | undefined;
  readonly allowance: () => OneTimeAllowance | undefined;
}

/** Performs a verb, parking top-level refusals through the gate and navigating only with the person's allowance. */
export const performBrowserCall = async (
  driver: PageDriver,
  initial: PageCallOf<PageVerb>,
  context: { readonly call: HostToolCall; readonly tool: string; readonly input: JsonObject; readonly policy: BrowserCallPolicy; readonly snapshot?: PageArgs<"navigate">["snapshot"] },
): Promise<{ readonly command: PageCallOf<PageVerb>["command"]; readonly result: PageResult<PageVerb>; readonly notes: readonly string[] }> => {
  const { call, tool, input, policy } = context;
  let command = initial.command;
  let allowance = policy.allowance();
  const tried = new Set<string>();
  const notes: string[] = [];
  const refuse = (reason: string) => ({ command, result: { ok: false as const, reason }, notes });
  for (;;) {
    if (call.signal?.aborted === true) return refuse("The browser call was cancelled.");
    let result: PageResult<PageVerb>;
    try {
      result = await driver.perform({ pageKey: initial.pageKey, command, ...(allowance !== undefined && { allowance }) } as PageCallOf<PageVerb>);
    } catch (error) {
      return refuse(`The browser failed: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (result.ok || result.denylist === undefined) return { command, result, notes };
    const { match, frame } = result.denylist;
    const reason = `${result.reason}${policy.environmentId === undefined ? "" : ` The matching entry belongs to environment ${policy.environmentId}.`}`;
    if (policy.gate === undefined || policy.gate === null || call.toolCallId === null || (frame === "top-level" && tried.has(match.matched))) return refuse(reason);
    tried.add(match.matched);
    const decision = await policy.gate.check({
      toolCallId: call.toolCallId,
      tool,
      summary: reason,
      input,
      access: { kind: "browse", urls: [match.matched], match, frame, ...(policy.environmentId !== undefined && { environmentId: policy.environmentId }) },
    }, call.signal);
    if (decision.decision === "deny" || frame === "sub-frame") return refuse(reason);
    if (decision.message !== undefined) notes.push(decision.message);
    allowance = policy.allowance();
    if (allowance === undefined) return refuse(reason);
    command = { verb: "navigate", args: { url: match.matched, ...(context.snapshot !== undefined && { snapshot: context.snapshot }) } };
  }
};
