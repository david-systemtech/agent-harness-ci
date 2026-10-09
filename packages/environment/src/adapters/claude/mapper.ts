import type { ContextReading, JsonObject, ModelUsage, RunError } from "@agent-harness/contracts";
import { recordedImage, type AdapterEvent, type RunEnd, type ToolDenial, type TranscriptEvent } from "../../adapter/contract.js";
import type { SpendMeter } from "./spend.js";
import type { TaskLedger } from "./tasks.js";

/**
 * The mapper (claude-adapter spec, "The Claude adapter, ported after the
 * audit's fixes"): one SDK message in, the transcript events it means out,
 * for one turn. Pure
 * over its arguments: everything it remembers is on the turn's state, which
 * the process owns and hands in (the ledger is the process's, shared by its
 * turns). Deltas come out one per stream fragment; the delta batcher gathers
 * them. SDK messages are read structurally rather than through the SDK's
 * unions, so a payload the SDK reshapes degrades to no event instead of a
 * throw inside the pump; a type it does not know stays opaque, passed over
 * (ADR 0001).
 *
 * What it does not map, by decision: a subagent's own text and thinking
 * (its transcript is read on demand, not logged; its tool calls are, nested
 * under the call that started it), the prompt echo and replayed history (the
 * host records what was sent), and per-message spend (the result carries the process's so far, whose
 * difference from the reading before is the run's). Main request input usage is reported separately as
 * current context.
 */

/** A tool call opened and not yet ended. */
interface OpenTool {
  readonly startedAt: number;
}

/** The message a stream is building, by stream (the main thread, or a subagent's tool call). */
interface Stream {
  readonly messageId: string;
  blockIndex: number | undefined;
}

/** An item streamed and not yet settled, whose text an interrupt keeps (ADR 0022). */
interface OpenItem {
  readonly kind: "text" | "thinking";
  text: string;
}

export interface MapperState {
  /** Whether this turn has reported the provider's session (once per run). */
  linked: boolean;
  providerSessionId: string | null;
  /** Set by the end: nothing is mapped after it. */
  ended: boolean;
  completed: boolean;
  suggested: boolean;
  /** Set by an interrupt, so the ending reads as one whatever the provider calls it. */
  interruptRequested: boolean;
  readonly openTools: Map<string, OpenTool>;
  readonly closedTools: Set<string>;
  /** The calls whose denial the turn has reported, from a frame or the result (#131). */
  readonly deniedTools: Set<string>;
  readonly streams: Map<string, Stream>;
  readonly openItems: Map<string, OpenItem>;
  /** The provider's last in-band error, for an ending that names none. */
  lastError: RunError | null;
  context: ContextReading | null;
  contextMessageId: string | null;
  /** The process's delegated-work ledger, shared across its turns. */
  readonly ledger: TaskLedger;
  /** The process's spend so far, shared across its turns: a result's share of it is the turn's. */
  readonly spend: SpendMeter;
  readonly now: () => number;
}

export const createMapperState = (options: { readonly ledger: TaskLedger; readonly spend: SpendMeter; readonly now: () => number }): MapperState => ({
  linked: false,
  providerSessionId: null,
  ended: false,
  completed: false,
  suggested: false,
  interruptRequested: false,
  openTools: new Map(),
  closedTools: new Set(),
  deniedTools: new Set(),
  streams: new Map(),
  openItems: new Map(),
  lastError: null,
  context: null,
  contextMessageId: null,
  ledger: options.ledger,
  spend: options.spend,
  now: options.now,
});

type Record_ = Record<string, unknown>;

const isRecord = (value: unknown): value is Record_ => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0);

/** Any value as JSON the log can hold: a copy, with what JSON cannot carry dropped. */
export const toJson = (value: unknown): unknown => {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return String(value);
  }
};

const toJsonObject = (value: unknown): JsonObject => {
  const json = toJson(value);
  return isRecord(json) ? json : { value: json };
};

/**
 * A tool's result as the transcript records it (#540): each image block in
 * it (`{type: image, source: {type: base64, media_type, data}}`, what the
 * CLI hands the model for an MCP tool's image) as its media type and size
 * (`recordedImage`), never its bytes, which the model read and the log never
 * holds. A structured Read image or PDF (#621) keeps its file metadata with the
 * base64 replaced by the returned media type and byte size; everything else
 * as it is.
 */
const withoutFileBytes = (output: unknown): unknown => {
  if (isRecord(output) && (output["type"] === "image" || output["type"] === "pdf") && isRecord(output["file"]) && typeof output["file"]["base64"] === "string") {
    const { base64, ...file } = output["file"];
    const mediaType = output["type"] === "pdf" ? "application/pdf" : typeof file["type"] === "string" ? file["type"] : "application/octet-stream";
    return { ...output, file: { ...file, mediaType, size: Buffer.byteLength(base64, "base64") } };
  }
  if (!Array.isArray(output)) return output;
  return output.map((block: unknown) => {
    if (!isRecord(block) || block["type"] !== "image" || !isRecord(block["source"])) return block;
    const { source } = block;
    if (source["type"] !== "base64" || typeof source["data"] !== "string") return block;
    return recordedImage(typeof source["media_type"] === "string" ? source["media_type"] : "application/octet-stream", Buffer.byteLength(source["data"], "base64"));
  });
};

/** The stream a message belongs to: a subagent's under its tool call, else the main thread's. */
const MAIN = "";
const streamOf = (message: Record_): string => text(message["parent_tool_use_id"]) ?? MAIN;

const itemIdOf = (messageId: string, index: number): string => `${messageId}:${index}`;

const event = <T extends TranscriptEvent["type"]>(type: T, payload: Extract<TranscriptEvent, { type: T }>["payload"]): TranscriptEvent =>
  ({ type, payload }) as TranscriptEvent;

const startTool = (state: MapperState, block: Record_, parent: string | null): TranscriptEvent[] => {
  const id = text(block["id"]);
  const name = text(block["name"]);
  if (id === null || name === null || state.openTools.has(id) || state.closedTools.has(id)) return [];
  state.openTools.set(id, { startedAt: state.now() });
  return [event("tool.started", { toolCallId: id, name, input: toJsonObject(block["input"]), title: null, agentId: parent, parentToolCallId: parent })];
};

/**
 * Ends a tool call once. Only one this turn saw start: an end for another
 * (a result or denial for a call of an earlier turn, which that turn's end
 * cancelled) would be a `tool.ended` with no `tool.started` to pair with.
 */
const endTool = (state: MapperState, id: string, status: "ok" | "error" | "cancelled", output: unknown): TranscriptEvent[] => {
  const open = state.openTools.get(id);
  if (open === undefined) return [];
  state.openTools.delete(id);
  state.closedTools.add(id);
  return [event("tool.ended", { toolCallId: id, status, output: toJson(withoutFileBytes(output)) as never, durationMs: Math.max(0, state.now() - open.startedAt) })];
};

/** The kind of reason a denial report names (`decision_reason_type`), as the harness's deciders read it: anything else is the provider's own. */
const DENIED_BY: Readonly<Record<string, ToolDenial["by"]>> = { rule: "rule", classifier: "classifier", mode: "mode" };

/** The provider's denial of a call the turn saw start, once per call. */
const denial = (state: MapperState, id: string, toolName: string | null, by: ToolDenial["by"], reason: string | null): ToolDenial[] => {
  if (state.deniedTools.has(id) || !(state.openTools.has(id) || state.closedTools.has(id))) return [];
  state.deniedTools.add(id);
  return [{ type: "denial", toolCallId: id, toolName, by, reason }];
};

/**
 * A `permission_denied` frame: the CLI denied a call without asking the
 * broker (a deny rule, its classifier, its mode). Reported as the call's
 * denial, by the reason's kind, then its end.
 */
const mapPermissionDenied = (message: Record_, state: MapperState): AdapterEvent[] => {
  const id = text(message["tool_use_id"]);
  if (id === null || !state.openTools.has(id)) return [];
  const kind = text(message["decision_reason_type"]);
  // An own property only: an inherited one (`constructor`, `valueOf`) is no kind of ours.
  const by = kind !== null && Object.hasOwn(DENIED_BY, kind) ? (DENIED_BY[kind] ?? "provider") : "provider";
  const said = text(message["message"]);
  return [...denial(state, id, text(message["tool_name"]), by, text(message["decision_reason"]) ?? said), ...endTool(state, id, "error", said ?? "The tool call was denied.")];
};

/**
 * The result's `permission_denials`, the CLI's authoritative record: a
 * denial no frame reported (a path-scoped deny rule on a file tool, a race)
 * is reported here as a rule's, for a call the turn saw; one the broker was
 * asked about is the prompt's, and the host keeps the prompt's answer.
 */
const resultDenials = (message: Record_, state: MapperState): ToolDenial[] => {
  const denials = Array.isArray(message["permission_denials"]) ? message["permission_denials"] : [];
  return denials.flatMap((entry: unknown) => {
    const id = isRecord(entry) ? text(entry["tool_use_id"]) : null;
    return id === null || !isRecord(entry) ? [] : denial(state, id, text(entry["tool_name"]), "rule", null);
  });
};

const mapInit = (message: Record_, state: MapperState): TranscriptEvent[] => {
  const sessionId = text(message["session_id"]);
  if (sessionId === null) return [];
  state.providerSessionId = sessionId;
  if (state.linked) return [];
  state.linked = true;
  return [event("session.provider-linked", { providerSessionId: sessionId })];
};

/** Input context belongs to one main request; output and subagent usage never enter it. */
const mapContext = (body: unknown, state: MapperState): TranscriptEvent[] => {
  if (!isRecord(body) || !isRecord(body["usage"])) return [];
  const model = text(body["model"]);
  const id = text(body["id"]);
  const usage = body["usage"];
  const counts = [usage["input_tokens"], usage["cache_read_input_tokens"] ?? 0, usage["cache_creation_input_tokens"] ?? 0];
  if (model === null || id === null || !counts.every((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return [];
  const contextTokens = counts.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(contextTokens)) return [];
  if (state.contextMessageId === id && state.context?.model === model && state.context.contextTokens === contextTokens) return [];
  const contextWindow = state.context?.model === model ? state.context.contextWindow : null;
  state.contextMessageId = id;
  state.context = { model, contextTokens, contextWindow };
  return [event("context.reported", state.context)];
};

const mapStreamEvent = (message: Record_, state: MapperState): TranscriptEvent[] => {
  const key = streamOf(message);
  const raw = message["event"];
  if (!isRecord(raw)) return [];
  switch (raw["type"]) {
    case "message_start": {
      const id = isRecord(raw["message"]) ? text(raw["message"]["id"]) : null;
      if (id !== null) state.streams.set(key, { messageId: id, blockIndex: undefined });
      return key === MAIN ? mapContext(raw["message"], state) : [];
    }
    case "content_block_start": {
      const stream = state.streams.get(key);
      if (stream !== undefined && typeof raw["index"] === "number") stream.blockIndex = raw["index"];
      return [];
    }
    case "content_block_delta": {
      // A subagent's words are its own transcript's, read on demand.
      if (key !== MAIN) return [];
      const stream = state.streams.get(key);
      const index = raw["index"];
      const delta = raw["delta"];
      if (stream === undefined || typeof index !== "number" || !isRecord(delta)) return [];
      stream.blockIndex = index;
      const kind = delta["type"] === "text_delta" ? "text" : delta["type"] === "thinking_delta" ? "thinking" : null;
      const fragment = kind === "text" ? text(delta["text"]) : kind === "thinking" ? text(delta["thinking"]) : null;
      if (kind === null || fragment === null) return [];
      const itemId = itemIdOf(stream.messageId, index);
      const open = state.openItems.get(itemId);
      if (open === undefined) state.openItems.set(itemId, { kind, text: fragment });
      else open.text += fragment;
      return [event("assistant.delta", { itemId, fragments: [{ kind, text: fragment }] })];
    }
    case "message_stop":
      state.streams.delete(key);
      return [];
    default:
      return [];
  }
};

const mapAssistant = (message: Record_, state: MapperState): TranscriptEvent[] => {
  const body = message["message"];
  if (!isRecord(body)) return [];
  const parent = text(message["parent_tool_use_id"]);
  const error = text(message["error"]);
  if (error !== null) state.lastError = { message: `The provider reported ${error} while answering.`, code: error };
  const content = Array.isArray(body["content"]) ? body["content"] : [];
  const messageId = text(body["id"]) ?? text(message["uuid"]) ?? "message";
  // A streamed message arrives one settled block at a time, under the index the stream gave it.
  const stream = state.streams.get(streamOf(message));
  const streamedIndex = stream !== undefined && stream.messageId === messageId && content.length === 1 ? stream.blockIndex : undefined;
  const aborted = message["aborted"] === true;
  const events: TranscriptEvent[] = parent === null && error === null ? mapContext(body, state) : [];
  content.forEach((block: unknown, position: number) => {
    if (!isRecord(block)) return;
    const itemId = itemIdOf(messageId, streamedIndex ?? position);
    switch (block["type"]) {
      case "text":
      case "thinking": {
        if (parent !== null) return;
        const kind = block["type"];
        const streamed = state.openItems.get(itemId)?.text ?? "";
        const own = typeof block[kind] === "string" ? (block[kind] as string) : "";
        // A settled block can come back empty (thinking omitted from the settled copy) though its text streamed: the streamed text stands.
        const said = own === "" ? streamed : own;
        state.openItems.delete(itemId);
        if (kind === "thinking" && said === "") return;
        events.push(event(kind === "text" ? "assistant.text" : "assistant.thinking", { itemId, text: said, aborted }));
        return;
      }
      case "tool_use":
      case "server_tool_use":
      case "mcp_tool_use":
        events.push(...startTool(state, block, parent));
        return;
      default: {
        // A server tool's result rides the assistant message (web search, fetch).
        const id = text(block["tool_use_id"]);
        if (id !== null && typeof block["type"] === "string" && block["type"].endsWith("_tool_result")) {
          events.push(...endTool(state, id, block["is_error"] === true ? "error" : "ok", block["content"]));
        }
      }
    }
  });
  return events;
};

const mapUser = (message: Record_, state: MapperState): TranscriptEvent[] => {
  // The stream a message ends is done: a tool result closes the assistant message that asked.
  state.streams.delete(streamOf(message));
  const body = message["message"];
  if (!isRecord(body) || !Array.isArray(body["content"])) return [];
  const results = body["content"].filter((block): block is Record_ => isRecord(block) && block["type"] === "tool_result");
  return results.flatMap((block) => {
    const id = text(block["tool_use_id"]);
    if (id === null) return [];
    // The structured output, when the message carries one result, is what the tool returned; else the text the model read.
    const output = results.length === 1 && message["tool_use_result"] !== undefined ? message["tool_use_result"] : block["content"];
    return endTool(state, id, block["is_error"] === true ? "error" : "ok", output);
  });
};

const mapToolProgress = (message: Record_, state: MapperState): TranscriptEvent[] => {
  const id = text(message["tool_use_id"]);
  if (id === null || !state.openTools.has(id)) return [];
  return [event("tool.updated", { toolCallId: id, update: { elapsedSeconds: count(message["elapsed_time_seconds"]) } })];
};

const RATE_LIMIT_STATUS: Readonly<Record<string, "allowed" | "warning" | "rejected">> = {
  allowed: "allowed",
  allowed_warning: "warning",
  rejected: "rejected",
};

/** The rate-limit verdict of a message, when it names a window and a status; also what the plan-usage read folds in. */
export const readRateLimit = (message: unknown): { window: string; status: "allowed" | "warning" | "rejected"; utilisation: number | null; resetsAt: string | null } | null => {
  if (!isRecord(message) || message["type"] !== "rate_limit_event" || !isRecord(message["rate_limit_info"])) return null;
  const info = message["rate_limit_info"];
  const status = typeof info["status"] === "string" ? RATE_LIMIT_STATUS[info["status"]] : undefined;
  const window = text(info["rateLimitType"]);
  if (status === undefined || window === null) return null;
  const used = info["utilization"];
  const resets = info["resetsAt"];
  return {
    window,
    status,
    // A percentage, carried as the vocabulary's fraction.
    utilisation: typeof used === "number" && Number.isFinite(used) ? Math.max(0, used) / 100 : null,
    // Epoch seconds, or milliseconds from a producer that sends those.
    resetsAt: typeof resets === "number" && Number.isFinite(resets) && resets > 0 ? new Date(resets > 1e12 ? resets : resets * 1000).toISOString() : null,
  };
};

/**
 * Closes a turn: its open tool calls cancelled, its open items settled as
 * aborted with the text they had (ADR 0022), then its one end. Nothing when
 * the turn has ended already, so a turn ends once whoever ends it.
 */
export const endTurn = (state: MapperState, end: Omit<RunEnd, "type">): AdapterEvent[] => {
  if (state.ended) return [];
  state.ended = true;
  state.completed = end.reason === "completed";
  const events: AdapterEvent[] = [];
  for (const id of [...state.openTools.keys()]) events.push(...endTool(state, id, "cancelled", null));
  for (const [itemId, item] of state.openItems) {
    events.push(event(item.kind === "text" ? "assistant.text" : "assistant.thinking", { itemId, text: item.text, aborted: true }));
  }
  state.openItems.clear();
  state.streams.clear();
  const interrupted = state.interruptRequested && end.reason !== "completed";
  events.push({
    type: "end",
    reason: interrupted ? "interrupted" : end.reason,
    cause: interrupted ? "user" : (end.cause ?? null),
    error: interrupted || end.reason !== "error" ? null : (end.error ?? state.lastError ?? { message: "The run failed.", code: null }),
    usage: end.usage ?? null,
    turnCount: end.turnCount ?? null,
    resultText: end.resultText ?? null,
  });
  return events;
};

/** A result: the turn's share of the process's spend (`spend`, the reading and its share), its context window, its denials and its end. */
const mapResult = (message: Record_, state: MapperState, spend: { readonly reading: ModelUsage[]; readonly share: ModelUsage[] }): AdapterEvent[] => {
  const usage = spend.share;
  const succeeded = message["subtype"] === "success" && message["is_error"] !== true;
  const errors = Array.isArray(message["errors"]) ? message["errors"].filter((entry): entry is string => typeof entry === "string" && entry !== "") : [];
  const error: RunError | null = succeeded
    ? null
    : {
        message: errors.join("; ") || text(message["result"]) || state.lastError?.message || "The run failed.",
        code: state.lastError?.code ?? text(message["terminal_reason"]) ?? text(message["subtype"]),
      };
  // The denials no frame reported come before the ending, so the host has every call's before it settles the rest.
  const denominator = spend.reading.find((entry) => entry.model === state.context?.model)?.contextWindow;
  const contextEvents: TranscriptEvent[] = [];
  if (state.context !== null && denominator != null && denominator !== state.context.contextWindow) {
    state.context = { ...state.context, contextWindow: denominator };
    contextEvents.push(event("context.reported", state.context));
  }
  const reported: AdapterEvent[] = [...contextEvents, ...(usage.length > 0 ? [event("usage.reported", { models: usage })] : []), ...resultDenials(message, state)];
  const end = endTurn(state, {
    reason: succeeded ? "completed" : "error",
    error,
    usage: usage.length > 0 ? usage : null,
    turnCount: count(message["num_turns"]),
    resultText: succeeded ? text(message["result"]) : null,
  });
  // The usage and the denials come first, then whatever the ending cancels and settles, then the end.
  return [...reported, ...end];
};

/** The ledger's rows, when a message changed them. */
const tasksChanged = (state: MapperState): TranscriptEvent[] => (state.ledger.dirty ? [event("tasks.changed", { tasks: state.ledger.snapshot() })] : []);

/**
 * One SDK message as the transcript events it means for the turn `state`
 * belongs to. The ledger reads every message, ended turn or not, so work
 * that outlives a turn is known to the next, and the spend meter every result, so a result after
 * the turn's end is not counted again by the next; only its prompt suggestion is mapped once the
 * turn has ended.
 */
export const mapSdkMessage = (message: unknown, state: MapperState): AdapterEvent[] => {
  if (!isRecord(message)) return [];
  state.ledger.observe(message);
  const spend = state.spend.read(message);
  if (message["type"] === "prompt_suggestion") {
    const suggestion = text(message["suggestion"]);
    if (!state.completed || state.suggested || suggestion === null || suggestion.trim() === "") return [];
    state.suggested = true;
    return [event("run.suggested", { suggestion })];
  }
  if (state.ended) return [];
  switch (message["type"]) {
    case "system":
      switch (message["subtype"]) {
        case "init":
          return mapInit(message, state);
        case "permission_denied":
          return mapPermissionDenied(message, state);
        case "background_tasks_changed":
        case "task_started":
        case "task_progress":
        case "task_updated":
        case "task_notification":
          return tasksChanged(state);
        default:
          return [];
      }
    case "stream_event":
      return mapStreamEvent(message, state);
    case "assistant":
      return mapAssistant(message, state);
    case "user":
      return mapUser(message, state);
    case "tool_progress":
      return mapToolProgress(message, state);
    case "rate_limit_event": {
      const verdict = readRateLimit(message);
      return verdict === null ? [] : [event("plan.limit", verdict)];
    }
    case "result":
      return spend === null ? [] : mapResult(message, state, spend);
    default:
      return [];
  }
};
