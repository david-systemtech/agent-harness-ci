import {
  PromptOpenedPayload,
  type AutoDecider,
  type DecidedBy,
  type EventEnvelope,
  type ListedPrompt,
  type Mode,
  type PromptAnsweredPayload,
  type SessionSummary,
  type SummaryPatch,
} from "@agent-harness/contracts";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's parked prompts (permissions spec, "Prompts,
 * parked prompts and the TTL"; #130's methods): a prompt parks on a
 * session's live run as the broker parks it (`prompt.opened` on the
 * session's stream with its summary patch, then the `prompt.parked` notice
 * on the environment's), `permissions.prompts.list` lists what is parked,
 * and `permissions.prompts.answer` answers it once: `prompt.answered`, then
 * `prompt.resolved`, a second answer refused `conflict` `already_answered`,
 * and a retry of an applied command answered from its stored receipt, as the
 * environment answers one. A test can have another client answer first,
 * heard now or later, or an automatic rule settle it, and can hold an
 * answer's response while it applies, for the socket to drop before it
 * arrives.
 */

export interface PromptsHost {
  readonly clock: ManualClock;
  readonly wire: FakeWire;
  emit(sessionId: string, type: string, payload: Record<string, unknown>, change?: { readonly fields?: Partial<SessionSummary>; readonly patch?: SummaryPatch }): EventEnvelope;
  /** Says a notice on the environment's own stream. */
  notice(type: string, payload: Record<string, unknown>): void;
  summary(sessionId: string): SessionSummary;
  liveRun(sessionId: string): string | undefined;
  /** The next sequence of the environment's log, for a receipt. */
  nextSequence(): number;
}

/** What a prompt a test parks says: every field of `prompt.opened`, the kind and the summary at least. */
export type ScriptedPrompt = Partial<PromptOpenedPayload>;

export interface ScriptedPrompts {
  /** Parks a prompt on the session's live run (or the run named); answers its id. */
  openPrompt(sessionId: string, prompt?: ScriptedPrompt): string;
  /**
   * Another client answers the prompt. Heard at once, or, with `heard:
   * false`, recorded by the environment but not yet said on any stream until
   * `hear` is called, as an answer on its way.
   */
  answerElsewhere(sessionId: string, promptId: string, options?: { readonly decision?: "allow" | "deny"; readonly heard?: boolean }): { hear(): void };
  /** An automatic rule settles the prompt (a denial, as the broker's are, unless `decision` says otherwise), with the message the model reads. */
  settleAutomatically(sessionId: string, promptId: string, auto: AutoDecider, options?: { readonly decision?: "allow" | "deny"; readonly message?: string }): void;
  /** Every answer the environment recorded, in order. */
  answered(): readonly PromptAnsweredPayload[];
  /** While on, an answer is applied but its response is never sent, as when the socket drops first. */
  holdAnswers(on: boolean): void;
}

/** The client session every answer from another client is said to come from. */
export const OTHER_CLIENT = "0199cc00-0000-7000-8000-00000000abcd";

export const scriptedPrompts = (host: PromptsHost): { readonly prompts: ScriptedPrompts; readonly answer: (params: Record<string, unknown>) => FakeAnswer | undefined } => {
  const { clock, wire } = host;
  const parked = new Map<string, ListedPrompt>();
  const done = new Set<string>();
  const receipts = new Map<string, FakeAnswer>();
  const answered: PromptAnsweredPayload[] = [];
  let holding = false;
  let minted = 0;
  const keyOf = (sessionId: string, promptId: string) => `${sessionId.toLowerCase()} ${promptId}`;

  wire.answer("permissions.prompts.list", (params) => {
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"].toLowerCase() : undefined;
    const prompts = [...parked.values()].filter((p) => sessionId === undefined || p.sessionId === sessionId).sort((a, b) => a.sequence - b.sequence);
    return { result: { prompts } };
  });

  const openPrompt: ScriptedPrompts["openPrompt"] = (sessionId, prompt = {}) => {
    const runId = prompt.runId ?? host.liveRun(sessionId);
    if (runId === undefined) throw new Error(`No run is live on ${sessionId} to park a prompt on.`);
    const kind = prompt.kind ?? "permission";
    const payload = PromptOpenedPayload.parse({
      runId,
      promptId: `prompt-${++minted}`,
      kind,
      toolName: kind === "permission" || kind === "denylist" ? "Bash" : null,
      toolCallId: null,
      input: kind === "permission" || kind === "denylist" ? { command: "rm -rf build" } : null,
      summary: "Bash: rm -rf build",
      blockedPath: null,
      reason: null,
      questions: null,
      plan: null,
      suggestions: [],
      agentId: null,
      denylist: null,
      mode: "acceptEdits",
      ceiling: "bypassPermissions",
      ttlExpiresAt: null,
      ...prompt,
    });
    const summary = host.summary(sessionId);
    const at = clock.now().toISOString();
    const event = host.emit(sessionId, "prompt.opened", payload, { fields: { parkedPromptCount: summary.parkedPromptCount + 1, activity: { state: "parked", since: at } } });
    parked.set(keyOf(sessionId, payload.promptId), { sessionId: sessionId.toLowerCase(), promptId: payload.promptId, sequence: event.sequence, openedAt: event.occurredAt, prompt: payload });
    host.notice("prompt.parked", { sessionId, runId, promptId: payload.promptId, kind, title: summary.title, summary: payload.summary });
    return payload.promptId;
  };

  /** Records the answer, and says it on the streams unless `quiet`: `prompt.answered` with the summary patch, then `prompt.resolved`. */
  const apply = (listed: ListedPrompt, answer: Record<string, unknown>, decidedBy: DecidedBy, quiet = false) => {
    const { sessionId, promptId, prompt } = listed;
    parked.delete(keyOf(sessionId, promptId));
    done.add(keyOf(sessionId, promptId));
    const decision = answer["decision"] === "allow" ? "allow" : "deny";
    const mode = prompt.kind === "plan" && decision === "allow" ? ((answer["mode"] as Mode | undefined) ?? null) : null;
    const payload: PromptAnsweredPayload = {
      runId: prompt.runId,
      promptId,
      decision,
      message: (answer["message"] as string | undefined) ?? null,
      answers: (answer["answers"] as Record<string, string> | undefined) ?? null,
      updatedInput: null,
      mode: prompt.kind === "plan" && decision === "allow" ? { requested: mode, effective: mode ?? "acceptEdits", ceiling: prompt.ceiling, clamped: false, clampReason: null } : null,
      remember: answer["remember"] === "session" ? "session" : null,
      decidedBy,
      // No run waits for a prompt its run's end or the provider settled.
      delivery: typeof decidedBy !== "string" && (decidedBy.auto === "run_ended" || decidedBy.auto === "cancelled") ? null : "live",
    };
    answered.push(payload);
    const say = () => {
      const summary = host.summary(sessionId);
      const count = Math.max(0, summary.parkedPromptCount - 1);
      const since = clock.now().toISOString();
      const activity = count > 0 ? { state: "parked" as const, since } : host.liveRun(sessionId) !== undefined ? { state: "running" as const, since } : { state: "idle" as const, since };
      host.emit(sessionId, "prompt.answered", payload, { fields: { parkedPromptCount: count, activity } });
      host.notice("prompt.resolved", { sessionId, runId: prompt.runId, promptId, decision, decidedBy });
    };
    if (!quiet) say();
    return { payload, say };
  };

  const rejected = (reason: string, code: string, message: string, data: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: host.nextSequence(), changed: false, reason, error: { code, message, data } } },
  });

  const answer = (params: Record<string, unknown>): FakeAnswer | undefined => {
    const commandId = String(params["commandId"]);
    // A retry of a command already applied is answered from its stored receipt, and applies nothing again.
    const stored = receipts.get(commandId);
    if (stored) return stored;
    const promptId = String(params["promptId"]);
    const wanted = typeof params["sessionId"] === "string" ? params["sessionId"].toLowerCase() : undefined;
    const listed = [...parked.values()].find((p) => p.promptId === promptId && (wanted === undefined || p.sessionId === wanted));
    if (!listed) {
      const known = [...done].some((key) => key.endsWith(` ${promptId}`) && (wanted === undefined || key.startsWith(`${wanted} `)));
      return known
        ? rejected("conflict", "conflict", "The prompt was already answered.", { reason: "already_answered" })
        : rejected("not_found", "not_found", "No such prompt.", { kind: "prompt" });
    }
    const { payload } = apply(listed, params, wire.credential()?.clientSessionId ?? "unknown");
    const receipt: FakeAnswer = { result: { receipt: { status: "accepted", sequence: host.nextSequence(), changed: true }, result: { sessionId: listed.sessionId, ...payload } } };
    receipts.set(commandId, receipt);
    return holding ? undefined : receipt;
  };

  const prompts: ScriptedPrompts = {
    openPrompt,
    answerElsewhere(sessionId, promptId, options = {}) {
      const listed = parked.get(keyOf(sessionId, promptId));
      if (!listed) throw new Error(`No prompt ${promptId} is parked on ${sessionId}.`);
      const heard = options.heard ?? true;
      const { say } = apply(listed, { decision: options.decision ?? "allow" }, OTHER_CLIENT, !heard);
      return { hear: heard ? () => undefined : say };
    },
    settleAutomatically(sessionId, promptId, auto, options = {}) {
      const listed = parked.get(keyOf(sessionId, promptId));
      if (!listed) throw new Error(`No prompt ${promptId} is parked on ${sessionId}.`);
      apply(listed, { decision: options.decision ?? "deny", message: options.message }, { auto });
    },
    answered: () => answered,
    holdAnswers(on) {
      holding = on;
    },
  };
  return { prompts, answer };
};
