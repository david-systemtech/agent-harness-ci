import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  MODES,
  SKILL_PLUGIN_NAME,
  type AdapterCapabilities,
  type AuthStatus,
  type JsonObject,
  type Mode,
  type ModeAvailability,
  type ProcessHoldKind,
  type RunSkillSetMember,
} from "@agent-harness/contracts";
import {
  inProcessToolAccess,
  inProcessToolKey,
  inProcessToolName,
  isInProcess,
  recordedImage,
  toolCallSummary,
  type AccountRef,
  type Adapter,
  type AdapterEvent,
  type CommandsScope,
  type GateDecision,
  type GatedToolCall,
  type HistoryEvent,
  type HostToolResult,
  type ModelOption,
  type ProcessPort,
  type ProviderCommand,
  type ProviderSessionInfo,
  type PromptDecision,
  type PromptDetail,
  type PromptKind,
  type PromptMessage,
  type ProviderTurn,
  type RunContext,
  type RunEnd,
  type RunInput,
  type ToolServer,
  type TranscriptEvent,
  type UsageReading,
  type UsageWindow,
} from "../src/adapter/contract.js";
import { afterInheritedGitConfig } from "../src/adapter/process-environment.js";
import { CLIENT_TOOL_SERVER } from "../src/completions/passthrough.js";
import type { Clock } from "../src/serve/clock.js";
import { MANUAL_CLOCK_START } from "./clock.js";

/**
 * The scripted fake adapter (claude-adapter spec, "Testing Decisions", the
 * primary seam): the adapter contract satisfied by a script of events per
 * run, with a stub status probe, a static catalogue with tiers, a usage
 * reading with an identity, and a synchronous, idempotent transcript delete
 * when it declares one. It replaces #108's minimal provider. Its
 * descriptor is Claude-shaped unless a test says otherwise: a provider queue
 * that steers, images, delegated work, a live mode change, and the four
 * modes, each available unless a test lists one unavailable.
 *
 * A run's events come from a channel the script feeds, so the fake can put
 * its own in beside the script's: a steered message's `message.delivered`,
 * the end an interrupt causes. A provider queue that does not steer holds
 * what it is sent and, when the turn completes, opens a turn with it on its
 * own, reported through the adoption hook, as a provider reading its queue does.
 * It gives a message it still holds back on `withdraw` (#228), and says it
 * no longer holds one a turn has taken; a test can hold every withdraw on a
 * gate (`holdWithdraws`) to race it against the provider's read. A test can
 * hold an interrupt's answer (`holdInterruptAnswers`) and have every send
 * refused late (`holdSendRefusals`), so the run's end comes before the
 * message is handed back (#245), and can hold the turn a completed turn's
 * queue opens (`holdTurnOpens`), so the run's end comes before that turn.
 *
 * Titles (session-state spec, "Title fallback"): the fake can declare
 * `titleRead`, answering a title of its own and recording each read, and
 * `titleWrite`, recording each mirrored user title.
 *
 * It keeps a provider process per session as a real adapter would: a
 * `createRun` for a session with none starts one, the next reuses it, and
 * `stopProcess` stops it; the records say which process each run went to.
 * A script holds the process with background work through the run
 * context's port (`backgroundTask`). A process is spawned with its run's
 * process environment (#307), supplied once and reported on its record
 * (`supplied`), with its run's instruction text (`instructions`) and with
 * its skill set's fingerprint (`fingerprint`, #495) and with its run's tool
 * servers (`toolServers`); a run whose key, instructions, trust, fingerprint
 * or in-process tools (`inProcessToolKey`) differ lets it go for a fresh
 * one, as Claude's adapter does. A kept process serves a later run with the
 * tool servers it was spawned with, as Claude's does (#139, #551): a
 * script's `input.toolServers` are its process's. A script runs a command in
 * what its process was supplied (`runCommand`).
 *
 * Accounts (#134): the status probe answers per account directory and can
 * be changed mid-test (`setStatus`), every read is recorded
 * (`statusReads`), and the fake names a directory of its own for
 * `accounts.adopt` (`ambientDirectory`), one that is not there unless a
 * test gives it one. It lists commands when a test gives it some, and
 * then, as Claude lists them, each member of the skill set it is handed:
 * `agent-harness:<name>` for one the generation links, `<name>` for a
 * native one; every listing is recorded with its scope (#495). A member's
 * invocation text is Claude's too. It lists an account directory's
 * sessions for Carry over when a test scripts them (`sessions`, #578).
 *
 * The tool gate (#132, #133): a script plays a tool call as a provider
 * does under the gate (`toolCall`), asking the run context's gate before its
 * own evaluation; each run records every ruling (`gated`). It calls one of
 * the run's in-process tools the same way (`callHostTool`, #540), the gate
 * handed what the tool declares the call reaches, and plays back the
 * images a tool answers as the transcript records them.
 *
 * Plan usage (#136): the reading is scripted per account and can be changed
 * mid-test (`setUsage`), may wait on a gate or throw, and every read is
 * recorded (`usageReads`), so a test counts the reads concurrent asks
 * shared; the preset reading is stamped with the fake's clock and names the
 * fake's provider, and a scripted one is answered as scripted. A run's
 * script reports a rate-limit verdict with `planLimit`.
 */

/** What a script is handed: the run's input, its context, and the messages the run is sent while it plays. */
export interface ScriptControls {
  /** The run's input, with its process's tool servers: a kept process serves the run with the ones it was spawned with. */
  readonly input: RunInput;
  readonly context: RunContext;
  /** Resolves with the next message the run is sent (a steer), or at once with one sent and not taken yet. */
  nextSent(): Promise<PromptMessage>;
  /** Opens a turn now with the messages the provider holds, as a provider that reads its queue mid-turn would; the host is told through the adoption hook. */
  openTurn(): void;
  /** Resolves with the next answer the host hands the run through `answerPrompt`. */
  nextAnswer(): Promise<{ readonly promptId: string; readonly decision: PromptDecision }>;
  /** Aborted when the run is interrupted or disposed. */
  readonly signal: AbortSignal;
  /** Whether this run is a turn the fake opened on its own. */
  readonly adopted: boolean;
  /** Settles with the variables the spawn of the run's process was supplied (#307). */
  environment(): Promise<Readonly<Record<string, string>>>;
}

/** A run's script: the events it plays, in order, ending (or not, or throwing) as a test needs. */
export type Script = (controls: ScriptControls) => Iterable<AdapterEvent> | AsyncIterable<AdapterEvent>;

/**
 * One provider process as the fake keeps it: its session, how many runs it
 * served, whether it has been stopped, and the process environment it was
 * spawned with (#307).
 */
export interface FakeProcessRecord {
  readonly sessionId: string;
  /** The runs `createRun` started on it. */
  runs: number;
  /** The key of the process environment it was spawned with: a run with another is served by a fresh process. */
  readonly key: string;
  /** Settles with the variables its spawn was supplied, which its scripted commands run in (`runCommand`). */
  readonly supplied: Promise<Readonly<Record<string, string>>>;
  /** The instruction text it was spawned with, fixed for its life: a run handed other text is served by a fresh process. */
  readonly instructions: string;
  /** Whether it was spawned for a trusted repository, fixed for its life as Claude's project settings are: a run with the other answer is served by a fresh process (#500). */
  readonly trusted: boolean;
  /** The fingerprint of the skill set it was spawned with, fixed for its life as Claude's plugins are: a run with another is served by a fresh process (#495). */
  readonly fingerprint: string | null;
  /** The tool servers it was spawned with, which serve every run on it, as Claude's MCP servers do: a run whose in-process tools differ is served by a fresh process. */
  readonly toolServers: readonly ToolServer[];
  /** Set when `stopProcess` is called for it. */
  stopping: boolean;
  /** Set when its stop has finished. */
  stopped: boolean;
  /** Set when the environment gave up waiting and killed it. */
  killed: boolean;
}

/** One run as the fake saw it. */
export interface FakeRunRecord {
  readonly input: RunInput;
  /** The process it ran on; an adopted turn runs on the process of the run it followed. */
  readonly process: FakeProcessRecord;
  readonly adopted: boolean;
  /** The messages the host handed it during the turn. */
  readonly sent: PromptMessage[];
  /** How many times its event stream was iterated: the host consumes it once. */
  iterations: number;
  interrupted: boolean;
  disposed: boolean;
  released: boolean;
  /** The tasks `stopTask` was asked to stop. */
  readonly stoppedTasks: string[];
  /** The modes `setMode` changed the live run to, in order. */
  readonly modeChanges: Mode[];
  /** Every tool call the run asked the gate about, with its ruling, in order. */
  readonly gated: { readonly call: GatedToolCall; readonly decision: GateDecision }[];
  /** The answers the host handed it through `answerPrompt`, in order. */
  readonly answers: { readonly promptId: string; readonly decision: PromptDecision }[];
  /** The messages the host asked it to take back (`withdraw`), in order, whether or not it still held them. */
  readonly withdrawals: string[];
}

export interface FakeAdapterOptions {
  /** Preset `fake`. */
  readonly provider?: string;
  /** Flags over the Claude-shaped preset. */
  readonly capabilities?: Partial<Omit<AdapterCapabilities, "provider" | "displayName">>;
  /** Every run's script, unless a run is given its own through `nextScripts`. Preset: one reply, then completed. */
  readonly script?: Script;
  /** The stub status probe, answering at once or when its promise settles. Preset: signed in as `<account id>@example.com`. */
  readonly status?: (account: AccountRef) => AuthStatus | Promise<AuthStatus>;
  /** The machine's own directory for the fake provider (`accounts.adopt`). Preset: a path that is not there. */
  readonly ambientDirectory?: string | null;
  /** Declares `commands` with these commands, recording each listing. Preset: not declared. */
  readonly commands?: readonly ProviderCommand[];
  /**
   * Declares `sessionListing`: the sessions each account's directory holds,
   * given, or read per account from a function that may answer later or
   * throw; every listing is recorded. Preset: not declared.
   */
  readonly sessions?: readonly ProviderSessionInfo[] | ((account: AccountRef) => readonly ProviderSessionInfo[] | Promise<readonly ProviderSessionInfo[]>);
  /**
   * With `sessions`, each listed session's history (`readHistory`, #579), by
   * provider session id, or read from a function that may answer later or
   * throw; a session it has none for is one the directory no longer holds
   * (null). Every read is recorded. Preset: none held.
   */
  readonly histories?: Readonly<Record<string, readonly HistoryEvent[]>> | ((account: AccountRef, providerSessionId: string) => readonly HistoryEvent[] | null | Promise<readonly HistoryEvent[] | null>);
  /** The static catalogue. Preset: opus, sonnet and haiku with tiers 3, 2 and 1. */
  readonly models?: readonly ModelOption[];
  /** The modes the descriptor lists, available or not. Preset: the four, every one available. */
  readonly modes?: readonly ModeAvailability[];
  /**
   * Whether the fake declares transcript delete: `true` deletes (and records
   * it), `{ fails }` records the call and throws `fails`, `async` records it
   * and answers with a promise, as an adapter that broke the synchronous
   * contract would. Preset: not declared.
   */
  readonly deleteTranscript?: true | "async" | { readonly fails: string };
  /**
   * Declares `titleRead`: the title the provider generated for a session,
   * given, or read per session from a function (null for none yet); `{ fails }`
   * throws on the read. Every read is recorded. Preset: not declared.
   */
  readonly title?: string | null | ((sessionId: string) => string | null) | { readonly fails: string };
  /**
   * Declares `titleWrite`: every mirrored user title is recorded, and `{ fails }`
   * records it and rejects with that message. Preset: not declared.
   */
  readonly titleWrite?: true | { readonly fails: string };
  /** A gate every process stop waits on before it finishes, so a test sees a process `stopping`. Preset: none. */
  readonly holdStops?: Gate;
  /** A gate every `withdraw` waits on, once recorded, before it looks at what the provider holds (#228). Preset: none. */
  readonly holdWithdraws?: Gate;
  /** A gate every `withdraw` waits on after it has cancelled (or failed to find) the message, before it answers: a slow answer (#228). Preset: none. */
  readonly holdWithdrawAnswers?: Gate;
  /**
   * A gate every `interrupt` waits on after it has cancelled the provider's queue (what it held, which the answer names,
   * opens no turn), before it stops the turn and answers: a slow answer, which the turn's own end may come before (#245).
   * Preset: none.
   */
  readonly holdInterruptAnswers?: Gate;
  /**
   * A gate every `send` waits on, once recorded, before it refuses the message, as a provider whose turn ended before it
   * took the message does: a late refusal (#245). Preset: none, every send taken.
   */
  readonly holdSendRefusals?: Gate;
  /**
   * A gate a provider queue that does not steer waits on, once its turn has completed holding messages, before it opens
   * the turn that reads them, as a CLI opens its next turn some time after its result: the run's end commits first, with
   * the provider still holding them (#245). Preset: none, the turn opens with the end.
   */
  readonly holdTurnOpens?: Gate;
  /**
   * Declares `subagentTranscripts`: each subagent's transcript by agent id, the
   * same for every session (none for an id not listed); every read is
   * recorded. Preset: not declared.
   */
  readonly subagentTranscripts?: Readonly<Record<string, readonly JsonObject[]>>;
  /** What stamps the preset usage reading's `readAt`; give it the test's manual clock. Preset: `MANUAL_CLOCK_START`, always. */
  readonly clock?: Pick<Clock, "now">;
  /** The plan-usage read, per account: answers at once, when its promise settles, or throws. Preset: `presetUsage`. */
  readonly usage?: UsageScript;
}

/** A plan-usage read a test scripts: the reading for the account, given the fake's clock's time. */
export type UsageScript = (account: AccountRef, now: Date) => UsageReading | Promise<UsageReading>;

/** The preset reading: signed in as `<account id>@example.com`, the 5-hour window a quarter used, read now. */
export const presetUsage: UsageScript = (account, now) => usageOf(`${account.id}@example.com`, [usageWindow("five_hour", 0.25, "2026-09-24T05:00:00.000Z")], now);

/** A reading of `email` on the fake provider with `windows`, read at `now`. */
export const usageOf = (email: string, windows: readonly UsageWindow[], now: Date, organisation: string | null = null): UsageReading => ({
  identity: { provider: "fake", email, organisation },
  windows,
  readAt: now.toISOString(),
});

/** One window of a reading: its name, its utilisation 0 to 1, and when it resets. */
export const usageWindow = (window: string, utilisation: number | null, resetsAt: string | null = null): UsageWindow => ({ window, utilisation, resetsAt });

/** A rate-limit verdict a run's script reports (`plan.limit`), with the utilisation and reset it names, if any. */
export const planLimit = (
  window: string,
  status: "allowed" | "warning" | "rejected",
  named: { readonly utilisation?: number | null; readonly resetsAt?: string | null } = {},
): TranscriptEvent => ({ type: "plan.limit", payload: { window, status, utilisation: named.utilisation ?? null, resetsAt: named.resetsAt ?? null } });

/** A commands listing as the fake was asked for it: the account, the workspace's path, and the trust and skill set the host resolved. */
export interface CommandListing {
  readonly account: AccountRef;
  readonly workspace: string;
  readonly scope: CommandsScope;
}

/** How the fake lists a member of the skill set it is handed, as Claude's CLI does: under the generation plugin's name unless it is native. */
const listedMember = (member: RunSkillSetMember): ProviderCommand => ({
  name: member.native ? member.name : `${SKILL_PLUGIN_NAME}:${member.name}`,
  description: `The skill set's ${member.name}.`,
});

/** A user title the environment mirrored into the provider's own title field. */
export interface MirroredTitle {
  readonly sessionId: string;
  readonly title: string;
}

export interface FakeAdapter extends Adapter {
  /** Every run created or opened, in order. */
  readonly runs: readonly FakeRunRecord[];
  /** The sessions whose transcripts the environment asked the fake to delete, in order, whether or not the delete failed. */
  readonly deletedTranscripts: readonly string[];
  /** Scripts for the next runs, taken one per run before the preset. */
  readonly nextScripts: Script[];
  /** The sessions whose provider title the environment read (`readTitle`), in order. */
  readonly titleReads: readonly string[];
  /** The user titles the environment mirrored (`writeTitle`), in order, whether or not the write failed. */
  readonly mirroredTitles: readonly MirroredTitle[];
  /** The subagent transcripts the environment read (`subagentTranscript`), in order. */
  readonly subagentReads: readonly { readonly sessionId: string; readonly agentId: string }[];
  /** The accounts each transcript delete was handed, in the order of `deletedTranscripts`. */
  readonly deletedTranscriptAccounts: readonly (readonly AccountRef[])[];
  /** The most recent run. */
  lastRun(): FakeRunRecord;
  /**
   * Resolves with the `count`th run once the fake has been asked for it
   * (created, or a turn it opened), at once when it has been: a run's launch
   * resolves its skill set and composes its instructions before its adapter
   * is asked (#493, #496), so a test that acts on the provider's run waits
   * for it here.
   */
  reached(count: number): Promise<FakeRunRecord>;
  /** Every provider process started, in order. */
  readonly processes: readonly FakeProcessRecord[];
  /** The session's processes, in the order they were started. */
  processesOf(sessionId: string): readonly FakeProcessRecord[];
  /** The session's live process exits on its own, and says so through the port its last run was handed. */
  exit(sessionId: string): void;
  /** Every status read, in order: the account reference it was asked with. */
  readonly statusReads: readonly AccountRef[];
  /** Replaces the status probe from now on. */
  setStatus(status: (account: AccountRef) => AuthStatus | Promise<AuthStatus>): void;
  /** The accounts whose directory the environment listed the sessions of (`listSessions`), in order. */
  readonly sessionListings: readonly AccountRef[];
  /** Every history read (`readHistory`), in order: the account and the provider session asked for. */
  readonly historyReads: readonly { readonly account: AccountRef; readonly providerSessionId: string }[];
  /** Every commands listing, in order, with the scope the host resolved for it. */
  readonly commandListings: readonly CommandListing[];
  /** Every plan-usage read, in order: the account reference it was asked with. */
  readonly usageReads: readonly AccountRef[];
  /** Replaces the plan-usage read from now on. */
  setUsage(usage: UsageScript): void;
}

/** The fake's own directory unless a test gives it one: a path that is not there, so nothing adopts it by chance. */
export const FAKE_AMBIENT_DIRECTORY = "/nonexistent/agent-harness-fake-ambient";

/** A status a test scripts: signed in as `email`, or signed out when it is null. */
export const signedInAs = (email: string | null, orgName: string | null = null): AuthStatus =>
  email === null
    ? { signedIn: false, authMethod: null, email: null, orgName: null, subscriptionType: null, error: null }
    : { signedIn: true, authMethod: "fake", email, orgName, subscriptionType: "max", error: null };

/** A gate a script waits on until a test opens it. */
export interface Gate {
  readonly opened: Promise<void>;
  open(): void;
}

export const gate = (): Gate => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
};

/** The assistant's settled text, as one item. */
export const say = (text: string, itemId: string = randomUUID()): TranscriptEvent => ({ type: "assistant.text", payload: { itemId, text, aborted: false } });

/** The end of a run: completed unless told otherwise. */
export const end = (reason: RunEnd["reason"] = "completed", extra: Omit<RunEnd, "type" | "reason"> = {}): RunEnd => ({ type: "end", reason, ...extra });

/** A call a script makes to one of the tools a completions request declared (#139). */
export interface ClientToolCallScript {
  readonly name: string;
  readonly input?: JsonObject;
  /** The provider's id for the call, as its `tool.started` names it; preset: a fresh `toolu_` id. */
  readonly toolCallId?: string;
}

/**
 * Calls the caller's own tools as a provider calls an in-process server's
 * (#139): a `tool.started` for each under the name the contract gives it
 * (`mcp__client__<name>`), then every call at once through the `client`
 * server the run was handed, as Claude's CLI runs concurrency-safe tools
 * side by side, the run's signal passed on; then a `tool.ended` for each
 * with what it answered. Returns the answers in the order of the calls.
 */
export async function* callClientTools(controls: ScriptControls, calls: readonly ClientToolCallScript[]): AsyncGenerator<AdapterEvent, HostToolResult[]> {
  const server = controls.input.toolServers.find((candidate) => candidate.name === CLIENT_TOOL_SERVER);
  if (server === undefined || !isInProcess(server)) throw new Error("The run was handed no client tool server.");
  const made = calls.map((call) => ({ ...call, input: call.input ?? {}, toolCallId: call.toolCallId ?? `toolu_${randomUUID()}` }));
  for (const call of made) {
    yield {
      type: "tool.started",
      payload: { toolCallId: call.toolCallId, name: inProcessToolName(CLIENT_TOOL_SERVER, call.name), input: call.input, title: null, agentId: null, parentToolCallId: null },
    };
  }
  const results = await Promise.all(
    made.map((call) => {
      const tool = server.tools.find((candidate) => candidate.name === call.name);
      if (tool === undefined) throw new Error(`The client server has no tool ${call.name}.`);
      return tool.call(call.input, { toolCallId: call.toolCallId, signal: controls.signal });
    }),
  );
  for (const [index, call] of made.entries()) {
    const result = results[index] as HostToolResult;
    yield { type: "tool.ended", payload: { toolCallId: call.toolCallId, status: result.isError ? "error" : "ok", output: result.text, durationMs: 1 } };
  }
  return results;
}

/** Calls one of the caller's own tools (`callClientTools`), returning its answer. */
export async function* callClientTool(controls: ScriptControls, call: ClientToolCallScript): AsyncGenerator<AdapterEvent, HostToolResult> {
  const [result] = yield* callClientTools(controls, [call]);
  return result as HostToolResult;
}

/** A call a script makes to one of the in-process tools the run was handed (#540). */
export interface HostToolCallScript {
  /** The server's name, as the factory built it. */
  readonly server: string;
  readonly name: string;
  readonly input?: JsonObject;
  /** The provider's id for the call, as its `tool.started` names it; preset: a fresh `toolu_` id. */
  readonly toolCallId?: string;
}

/**
 * Calls one of the run's in-process tools as a provider does under the gate
 * (#540, as Claude's hook does): a `tool.started` under the name the
 * contract gives it (`mcp__<server>__<tool>`), then the gate asked about it
 * with what the tool declares the call reaches (`inProcessToolAccess`: a
 * browser verb's addresses, a fetch reader's URLs, `other` when it declares
 * nothing) and the summary naming that; denied, the call ends `error` with
 * what the model is told and the tool never runs; allowed, the tool runs and
 * the call ends with what it answered, as the transcript records it: its
 * text, or, with images, its text (when there is any) and each image as its
 * media type and size (`recordedImage`), never its bytes. Returns what the
 * model read: the tool's answer, or the gate's denial as an error.
 */
export async function* callHostTool(controls: ScriptControls, call: HostToolCallScript): AsyncGenerator<AdapterEvent, HostToolResult> {
  const server = controls.input.toolServers.find((candidate) => candidate.name === call.server);
  if (server === undefined || !isInProcess(server)) throw new Error(`The run was handed no in-process server ${call.server}.`);
  const tool = server.tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) throw new Error(`The server ${call.server} has no tool ${call.name}.`);
  const name = inProcessToolName(call.server, call.name);
  const input = call.input ?? {};
  const toolCallId = call.toolCallId ?? `toolu_${randomUUID()}`;
  yield { type: "tool.started", payload: { toolCallId, name, input, title: null, agentId: null, parentToolCallId: null } };
  const access = inProcessToolAccess(controls.input.toolServers, name, input) ?? { kind: "other" };
  const decision = await controls.context.gate.check({ toolCallId, tool: name, summary: toolCallSummary(name, access), access, input }, controls.signal);
  if (decision.decision === "deny") {
    yield { type: "tool.ended", payload: { toolCallId, status: "error", output: decision.message, durationMs: 1 } };
    return { text: decision.message, isError: true };
  }
  const result = await tool.call(input, { toolCallId, signal: controls.signal });
  const images = result.images ?? [];
  const output =
    images.length === 0
      ? result.text
      : [...(result.text === "" ? [] : [{ type: "text", text: result.text }]), ...images.map((image) => recordedImage(image.mediaType, image.data.byteLength))];
  yield { type: "tool.ended", payload: { toolCallId, status: result.isError ? "error" : "ok", output, durationMs: 1 } };
  return result;
}

/** What a script says a client tool answered, so a test reads what reached the run. */
export const toolResultText = (result: HostToolResult): string => `Tool said${result.isError ? " (error)" : ""}: ${result.text}`;

/** What an asking script says once it is answered: the decision it got, as JSON, so a test reads what reached the run. */
export const toldText = (decision: PromptDecision): string => `Told ${JSON.stringify(decision)}`;

export interface AskOptions {
  /** The prompt's id, as an adapter with its own permission table names it; the host mints one when absent. */
  readonly promptId?: string;
  /** Waited on before asking; preset: asks at once. */
  readonly before?: Promise<unknown>;
  /** Cancels the request when it aborts, as a provider cancelling the tool call does. */
  readonly signal?: AbortSignal;
  /** How the run ends once answered; preset: completed. */
  readonly then?: RunEnd;
}

/**
 * A run that asks through the broker (permissions spec, "Prompts"): it says
 * it is working, asks a prompt of `kind` with `detail`, says what it was told
 * (`toldText`) and ends. An answer a person gives reaches it through the
 * broker's request, which the host settles, and through `answerPrompt`,
 * which the fake records in the run record's `answers` and hands out through `nextAnswer()`.
 */
export const ask =
  (kind: PromptKind, detail: PromptDetail = {}, options: AskOptions = {}): Script =>
  async function* ({ context, input }) {
    yield say("Working");
    await options.before;
    const decision = await context.broker.request({
      sessionId: input.sessionId,
      runId: input.runId,
      kind,
      detail,
      ...(options.promptId !== undefined && { promptId: options.promptId }),
      ...(options.signal !== undefined && { signal: options.signal }),
    });
    yield say(toldText(decision));
    yield options.then ?? end();
  };

/**
 * A tool call played as a provider plays one under the gate: `tool.started`,
 * then the gate's ruling, before the provider's own evaluation; then
 * `tool.ended`, `ok` when the gate allowed it and `error` carrying what the
 * model is told when it denied it. The run's record keeps the ruling.
 * `signal` is the provider giving up on the call while the gate rules (a
 * hook's timeout): the gate is handed it, and the call ends `cancelled`
 * when it has aborted by the ruling.
 */
export async function* toolCall(
  controls: ScriptControls,
  call: Omit<GatedToolCall, "toolCallId"> & { readonly toolCallId?: string },
  signal?: AbortSignal,
): AsyncGenerator<AdapterEvent> {
  const toolCallId = call.toolCallId ?? `toolu_${randomUUID()}`;
  yield {
    type: "tool.started",
    payload: { toolCallId, name: call.tool, input: call.input ?? { access: call.access.kind }, title: call.summary, agentId: null, parentToolCallId: null },
  };
  const decision = await controls.context.gate.check({ ...call, toolCallId }, signal);
  if (signal?.aborted === true) {
    yield { type: "tool.ended", payload: { toolCallId, status: "cancelled", output: "cancelled", durationMs: 1 } };
    return;
  }
  yield {
    type: "tool.ended",
    payload: decision.decision === "allow" ? { toolCallId, status: "ok", output: "done", durationMs: 1 } : { toolCallId, status: "error", output: decision.message, durationMs: 1 },
  };
}

/** What a scripted command answered: its exit code (null when it could not run or a signal ended it), and what it printed. */
export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `command` as a provider's shell tool does (#307): `tool.started` for
 * `Bash`, the gate asked about it as a shell command, then, allowed, the
 * command run by `/bin/sh` in the run's workspace, in the variables the
 * spawn of the run's process was supplied over this process's PATH and
 * `env`, the machine's own as a Claude process inherits them (supplied git
 * configuration numbered after theirs, as Claude's adapter layers it); then
 * `tool.ended` with what it printed, `ok` on exit code 0, or with the gate's
 * denial. #315's git tests run git through it.
 */
export async function* runCommand(
  controls: ScriptControls,
  command: string,
  options: { readonly env?: Readonly<Record<string, string>> } = {},
): AsyncGenerator<AdapterEvent, CommandResult> {
  const toolCallId = `toolu_${randomUUID()}`;
  const access = { kind: "shell", command } as const;
  yield { type: "tool.started", payload: { toolCallId, name: "Bash", input: { command }, title: command, agentId: null, parentToolCallId: null } };
  const decision = await controls.context.gate.check({ toolCallId, tool: "Bash", summary: toolCallSummary("Bash", access), access, input: { command } }, controls.signal);
  if (decision.decision === "deny") {
    yield { type: "tool.ended", payload: { toolCallId, status: "error", output: decision.message, durationMs: 1 } };
    return { code: null, stdout: "", stderr: decision.message };
  }
  const inherited = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", ...options.env };
  const env = { ...inherited, ...afterInheritedGitConfig(inherited, await controls.environment()) };
  const result = await new Promise<CommandResult>((resolve) => {
    execFile("/bin/sh", ["-c", command], { cwd: controls.input.workspace.path, env, signal: controls.signal }, (error, stdout, stderr) =>
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, stdout, stderr }),
    );
  });
  yield { type: "tool.ended", payload: { toolCallId, status: result.code === 0 ? "ok" : "error", output: `${result.stdout}${result.stderr}`, durationMs: 1 } };
  return result;
}

/** The preset script: one reply naming the prompt, then completed. */
export const replyScript: Script = ({ input }) => [say(`Done: ${input.prompt.map((message) => message.text).join(" / ")}`), end()];

/**
 * A run that leaves work behind on its process, as a provider's background
 * task or a schedule registered in the session does: it holds the process
 * through the context's port, says so and completes; the hold is let go when
 * `done` settles, long after the run has ended.
 */
export const backgroundTask =
  (id: string, done: Promise<void>, kind: ProcessHoldKind = "task"): Script =>
  ({ context }) => {
    context.process.hold(kind, id);
    void done.then(() => context.process.unhold(kind, id));
    return [say(`Started ${kind} ${id} in the background`), end()];
  };

const PRESET_MODELS: readonly ModelOption[] = [
  { id: "opus", family: "opus", tier: 3, efforts: ["low", "medium", "high", "max"] },
  { id: "sonnet", family: "sonnet", tier: 2, efforts: ["low", "medium", "high"] },
  { id: "haiku", family: "haiku", tier: 1, efforts: [] },
];

/** A channel a run's events flow through: pushed by the script and by the fake, iterated once by the host. */
const channel = () => {
  const buffered: AdapterEvent[] = [];
  let waiting: { resolve: (result: IteratorResult<AdapterEvent>) => void; reject: (error: unknown) => void } | undefined;
  let closed = false;
  let failure: { error: unknown } | undefined;
  const settle = (): void => {
    if (waiting === undefined) return;
    const next = buffered.shift();
    const { resolve, reject } = waiting;
    if (next !== undefined) {
      waiting = undefined;
      resolve({ value: next, done: false });
    } else if (failure !== undefined) {
      waiting = undefined;
      reject(failure.error);
    } else if (closed) {
      waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  };
  return {
    push(event: AdapterEvent): void {
      if (closed) return;
      buffered.push(event);
      settle();
    },
    close(): void {
      closed = true;
      settle();
    },
    fail(error: unknown): void {
      if (closed) return;
      failure = { error };
      closed = true;
      settle();
    },
    get closed(): boolean {
      return closed;
    },
    iterator(): AsyncIterator<AdapterEvent> {
      return {
        next: () =>
          new Promise<IteratorResult<AdapterEvent>>((resolve, reject) => {
            const next = buffered.shift();
            if (next !== undefined) return resolve({ value: next, done: false });
            if (failure !== undefined) return reject(failure.error);
            if (closed) return resolve({ value: undefined, done: true });
            waiting = { resolve, reject };
          }),
        return: async () => ({ value: undefined, done: true }),
      };
    },
  };
};

export const fakeAdapter = (options: FakeAdapterOptions = {}): FakeAdapter => {
  const provider = options.provider ?? "fake";
  const declaredDelete = options.deleteTranscript;
  const declaredTitle = options.title;
  const declaredWrite = options.titleWrite;
  const descriptor: AdapterCapabilities = {
    provider,
    displayName: "Fake",
    interactivePrompts: true,
    partialMessages: true,
    providerQueue: true,
    steering: true,
    resume: true,
    fork: false,
    rewind: false,
    sessionListing: options.sessions !== undefined,
    subagents: true,
    subagentTranscripts: options.subagentTranscripts !== undefined,
    titleRead: declaredTitle !== undefined,
    titleWrite: declaredWrite !== undefined,
    transcriptDelete: declaredDelete !== undefined,
    planUsage: true,
    liveModels: false,
    commands: options.commands !== undefined,
    imageInput: true,
    fileInput: false,
    modeChange: true,
    // The fake stands in for an adapter that enforces containment, as the Claude adapter does (#140), so the gate's rules can be driven.
    containment: true,
    instructionChannel: { kind: "system-prompt-append", maxCharacters: null },
    // Claude-shaped: a trusted repository's own instructions, `.claude/skills` and commands are the provider's to load; a
    // test declares an adapter without, or with other roots.
    nativeProjectInstructions: true,
    nativeSkillRoots: [".claude/skills", ".claude/commands"],
    modes: [...(options.modes ?? MODES.map((mode): ModeAvailability => ({ mode, available: true, reason: null })))],
    ...options.capabilities,
  };
  const runs: FakeRunRecord[] = [];
  /** Who waits for the fake to have been asked for a number of runs. */
  const reachedWaiters: { readonly count: number; readonly resolve: (run: FakeRunRecord) => void }[] = [];
  const deletedTranscripts: string[] = [];
  const nextScripts: Script[] = [];
  const titleReads: string[] = [];
  const mirroredTitles: MirroredTitle[] = [];
  const subagentReads: { sessionId: string; agentId: string }[] = [];
  const deletedTranscriptAccounts: (readonly AccountRef[])[] = [];
  const processes: FakeProcessRecord[] = [];
  /** The port each process's latest run was handed. */
  const ports = new Map<FakeProcessRecord, ProcessPort>();
  const statusReads: AccountRef[] = [];
  const commandListings: CommandListing[] = [];
  const sessionListings: AccountRef[] = [];
  const historyReads: { account: AccountRef; providerSessionId: string }[] = [];
  const listed = options.sessions;
  const histories = options.histories;
  let status = options.status;
  const usageReads: AccountRef[] = [];
  // The preset names the fake's own provider, whatever a test calls it; a scripted reading is answered as scripted.
  let usage: UsageScript = options.usage ?? (async (account, now) => {
    const reading = await presetUsage(account, now);
    return { ...reading, identity: { ...reading.identity, provider } };
  });

  /** The session's process as it is now: its latest, unless that one has been told to stop or has exited. */
  const liveProcess = (sessionId: string): FakeProcessRecord | undefined => {
    const latest = processes.findLast((process) => process.sessionId === sessionId);
    return latest === undefined || latest.stopping || latest.stopped ? undefined : latest;
  };

  /** Starts a process cold for the run: its process environment supplied once, for this spawn. */
  const spawn = (input: RunInput): FakeProcessRecord => {
    const supplied = input.processEnvironment.supply().then((answer) => answer.variables);
    // A script that never asks for the variables leaves a failed supply unheard: it is not an unhandled rejection.
    supplied.catch(() => undefined);
    const process: FakeProcessRecord = {
      sessionId: input.sessionId,
      runs: 0,
      key: input.processEnvironment.key,
      supplied,
      instructions: input.instructions,
      trusted: input.trusted,
      fingerprint: input.skillSet.fingerprint,
      toolServers: input.toolServers,
      stopping: false,
      stopped: false,
      killed: false,
    };
    processes.push(process);
    return process;
  };

  /** What a run's tool servers show the model, as Claude's adapter keys a process by them: an in-process server by its tools, another by its name. */
  const toolKey = (servers: readonly ToolServer[]): string => servers.map((server) => (isInProcess(server) ? inProcessToolKey(server) : server.name)).join("\n");

  /**
   * The session's process for a new run: the live one, or one started cold.
   * A live one spawned with another process environment, other
   * instructions, the other trust, another skill set or other in-process
   * tools is let go for a fresh one, as Claude lets its process go for a run
   * it cannot serve.
   */
  const processFor = (input: RunInput): FakeProcessRecord => {
    let process = liveProcess(input.sessionId);
    const spawnedFor =
      process !== undefined &&
      process.key === input.processEnvironment.key &&
      process.instructions === input.instructions &&
      process.trusted === input.trusted &&
      process.fingerprint === input.skillSet.fingerprint &&
      toolKey(process.toolServers) === toolKey(input.toolServers);
    if (process !== undefined && !spawnedFor) {
      process.stopping = true;
      process.stopped = true;
      process = undefined;
    }
    process ??= spawn(input);
    process.runs += 1;
    return process;
  };

  /** One run, played from `script` on `process`: `input.prompt` is what it opened with. */
  const play = (input: RunInput, context: RunContext, script: Script, adopted: boolean, process: FakeProcessRecord): ProviderTurn => {
    const record: FakeRunRecord = {
      input,
      process,
      adopted,
      sent: [],
      iterations: 0,
      interrupted: false,
      disposed: false,
      released: false,
      stoppedTasks: [],
      modeChanges: [],
      gated: [],
      answers: [],
      withdrawals: [],
    };
    runs.push(record);
    for (const waiter of reachedWaiters.filter((entry) => entry.count === runs.length)) {
      reachedWaiters.splice(reachedWaiters.indexOf(waiter), 1);
      waiter.resolve(record);
    }
    // The gate as this run's script asks it, recording each ruling on the run; an adopted turn is handed the context it followed with.
    const gated: RunContext = {
      ...context,
      gate: {
        check: async (call, signal) => {
          const decision = await context.gate.check(call, signal);
          record.gated.push({ call, decision });
          return decision;
        },
      },
    };
    const events = channel();
    const abort = new AbortController();
    /** Sent messages a steering provider has not folded yet, or a non-steering queue holds. */
    const untaken: PromptMessage[] = [];
    const takers: ((message: PromptMessage) => void)[] = [];
    const answers: { promptId: string; decision: PromptDecision }[] = [];
    const answerTakers: ((answer: { promptId: string; decision: PromptDecision }) => void)[] = [];
    let ended = false;

    const push = (event: AdapterEvent): void => {
      if (ended) return;
      events.push(event);
      if (event.type === "end") {
        ended = true;
        events.close();
        // A provider queue that does not steer reads what it holds when the turn ends, in a turn of its own.
        if (event.reason === "completed" && untaken.length > 0 && descriptor.providerQueue && !descriptor.steering) {
          const opens = options.holdTurnOpens;
          if (opens === undefined) openTurn();
          else void opens.opened.then(() => untaken.length > 0 && openTurn());
        }
      }
    };

    /**
     * Opens a turn on its own with the messages the provider holds, reported
     * through the adoption hook. An adopted turn has no input of its own: the
     * provider opens it, and the host mints its run id only when it adopts
     * it, so no provider can know the id. The fake replays the previous run's
     * input with the id left blank (never the previous run's id, which is a
     * different run) and the queued messages as the prompt; the context is
     * the previous run's, as the adoption hook is (`RunContext.adopt`).
     */
    function openTurn(): void {
      const queued = untaken.splice(0);
      const next = nextScripts.shift() ?? options.script ?? replyScript;
      const turn = play({ ...input, runId: "", prompt: queued }, context, next, true, process);
      context.adopt({ ...turn, messageIds: queued.map((message) => message.messageId) });
    }

    const controls: ScriptControls = {
      // The process's tool servers: a kept process serves the run with the ones it was spawned with.
      input: { ...input, toolServers: process.toolServers },
      context: gated,
      signal: abort.signal,
      adopted,
      environment: () => process.supplied,
      nextSent: () =>
        new Promise((resolve) => {
          const ready = untaken.shift();
          if (ready !== undefined) resolve(ready);
          else takers.push(resolve);
        }),
      openTurn,
      nextAnswer: () =>
        new Promise((resolve) => {
          const ready = answers.shift();
          if (ready !== undefined) resolve(ready);
          else answerTakers.push(resolve);
        }),
    };

    // The script plays once the host starts reading, so a test sees the run's start first.
    let started = false;
    const start = (): void => {
      if (started) return;
      started = true;
      void (async () => {
        try {
          for await (const event of script(controls)) {
            if (ended || abort.signal.aborted) break;
            push(event);
            if (ended) break;
          }
          if (!ended) events.close();
        } catch (error) {
          if (!ended) events.fail(error);
        }
      })();
    };

    const turn: ProviderTurn = {
      messageIds: [],
      events: {
        [Symbol.asyncIterator]: () => {
          record.iterations += 1;
          if (record.iterations > 1) throw new Error("A fake run's events were iterated twice; the host consumes them once.");
          start();
          return events.iterator();
        },
      },
      send(message) {
        record.sent.push(message);
        const refuse = options.holdSendRefusals;
        if (refuse !== undefined) {
          return refuse.opened.then(() => {
            throw new Error("The run has ended; its messages go to the next run.");
          });
        }
        if (descriptor.steering) push({ type: "message.delivered", payload: { messageId: message.messageId, delivery: "steered" } });
        const taker = takers.shift();
        if (taker !== undefined && descriptor.steering) taker(message);
        else untaken.push(message);
      },
      async withdraw(messageId) {
        record.withdrawals.push(messageId);
        await options.holdWithdraws?.opened;
        // Held until a turn takes it: a steering provider's taker, or the turn it opens with its queue.
        const at = untaken.findIndex((message) => message.messageId === messageId);
        if (at !== -1) untaken.splice(at, 1);
        await options.holdWithdrawAnswers?.opened;
        return { withdrawn: at !== -1 };
      },
      async interrupt() {
        record.interrupted = true;
        const stillQueued = descriptor.steering ? [] : untaken.splice(0).map((message) => message.messageId);
        // Held, the turn plays on meanwhile and may end on its own first; the end below is then a no-op.
        if (options.holdInterruptAnswers !== undefined) await options.holdInterruptAnswers.opened;
        abort.abort();
        push({ type: "end", reason: "interrupted", cause: "user" });
        return { stillQueued };
      },
      answerPrompt(promptId, decision) {
        const answer = { promptId, decision };
        record.answers.push(answer);
        const taker = answerTakers.shift();
        if (taker !== undefined) taker(answer);
        else answers.push(answer);
      },
      stopTask(taskId) {
        record.stoppedTasks.push(taskId);
      },
      setMode(mode) {
        record.modeChanges.push(mode);
      },
      dispose() {
        record.disposed = true;
        abort.abort();
        ended = true;
        events.close();
      },
      release() {
        record.released = true;
      },
    };
    return turn;
  };

  const adapter: FakeAdapter = {
    descriptor,
    credentials: {
      configDirVariable: "FAKE_CONFIG_DIR",
      strippedVariables: ["FAKE_API_KEY"],
      signIn: ["auth", "login"],
      status: ["auth", "status", "--json"],
      logout: ["auth", "logout"],
      parseStatus: (output) => JSON.parse(output) as AuthStatus,
    },
    status: async (account) => {
      statusReads.push(account);
      return status?.(account) ?? signedInAs(`${account.id}@example.com`);
    },
    ambientDirectory: () => (options.ambientDirectory === undefined ? FAKE_AMBIENT_DIRECTORY : options.ambientDirectory),
    ...(options.commands !== undefined && {
      commands: async (account: AccountRef, workspace: { readonly path: string }, scope: CommandsScope) => {
        commandListings.push({ account, workspace: workspace.path, scope });
        return [...(options.commands ?? []), ...scope.skillSet.members.map(listedMember)];
      },
    }),
    ...(listed !== undefined && {
      listSessions: async (account: AccountRef) => {
        sessionListings.push(account);
        return typeof listed === "function" ? listed(account) : listed;
      },
      readHistory: async (account: AccountRef, providerSessionId: string) => {
        historyReads.push({ account, providerSessionId });
        if (typeof histories === "function") return histories(account, providerSessionId);
        return histories?.[providerSessionId] ?? null;
      },
    }),
    invocationText: (member) => (member.native ? `/${member.name}` : `/${SKILL_PLUGIN_NAME}:${member.name}`),
    models: async () => ({ live: false, models: options.models ?? PRESET_MODELS }),
    createRun: (input, context) => {
      const process = processFor(input);
      ports.set(process, context.process);
      return play(input, context, nextScripts.shift() ?? options.script ?? replyScript, false, process);
    },
    async stopProcess(sessionId, stopOptions) {
      if (stopOptions?.kill === true) {
        for (const process of processes) {
          if (process.sessionId !== sessionId || process.stopped) continue;
          process.stopping = true;
          process.killed = true;
          process.stopped = true;
        }
        return;
      }
      const process = liveProcess(sessionId);
      if (process === undefined) return;
      process.stopping = true;
      await options.holdStops?.opened;
      process.stopped = true;
    },
    usage: async (account): Promise<UsageReading> => {
      usageReads.push(account);
      return usage(account, options.clock?.now() ?? new Date(MANUAL_CLOCK_START));
    },
    ...(declaredDelete !== undefined && {
      deleteTranscript: (sessionId: string, accounts: readonly AccountRef[]) => {
        deletedTranscripts.push(sessionId);
        deletedTranscriptAccounts.push(accounts);
        // The one cast: what the type refuses, an adapter could still do at run time.
        if (declaredDelete === "async") return Promise.resolve() as unknown as undefined;
        if (declaredDelete !== true) throw new Error(declaredDelete.fails);
        return undefined;
      },
    }),
    ...(declaredTitle !== undefined && {
      readTitle: async (sessionId: string) => {
        titleReads.push(sessionId);
        if (declaredTitle === null || typeof declaredTitle === "string") return declaredTitle;
        if (typeof declaredTitle === "function") return declaredTitle(sessionId);
        throw new Error(declaredTitle.fails);
      },
    }),
    ...(declaredWrite !== undefined && {
      writeTitle: async (sessionId: string, title: string) => {
        mirroredTitles.push({ sessionId, title });
        if (declaredWrite !== true) throw new Error(declaredWrite.fails);
      },
    }),
    ...(options.subagentTranscripts !== undefined && {
      subagentTranscript: async (sessionId: string, agentId: string) => {
        subagentReads.push({ sessionId, agentId });
        return options.subagentTranscripts?.[agentId] ?? [];
      },
    }),
    runs,
    subagentReads,
    deletedTranscriptAccounts,
    statusReads,
    setStatus(next) {
      status = next;
    },
    commandListings,
    sessionListings,
    historyReads,
    usageReads,
    setUsage(next) {
      usage = next;
    },
    deletedTranscripts,
    nextScripts,
    titleReads,
    mirroredTitles,
    processes,
    processesOf: (sessionId) => processes.filter((process) => process.sessionId === sessionId),
    exit(sessionId) {
      const process = liveProcess(sessionId);
      if (process === undefined) throw new Error(`The fake has no live process for session ${sessionId}.`);
      process.stopped = true;
      ports.get(process)?.exited();
    },
    lastRun() {
      const last = runs.at(-1);
      if (last === undefined) throw new Error("The fake adapter has run nothing yet.");
      return last;
    },
    reached(count) {
      const run = runs[count - 1];
      if (run !== undefined) return Promise.resolve(run);
      return new Promise((resolve) => reachedWaiters.push({ count, resolve }));
    },
  };
  return adapter;
};
