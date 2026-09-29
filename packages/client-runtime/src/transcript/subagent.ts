import type { JsonObject } from "@agent-harness/contracts";
import type { OpaqueEntry, ToolCallEntry, TranscriptEntry } from "../projections/session.js";
import { transcriptRows, type TranscriptRow } from "./rows.js";

/**
 * A subagent's own transcript as the transcript's rows (docs/specs/gui.md,
 * "The seven panes and the grid": the Tasks pane opens each agent's
 * transcript; the terminal UI's `delegated.open`). `sessions.subagentTranscript`
 * answers the provider's stored messages, never logged, in the provider's
 * shape: for Claude each is `{type, uuid, message: {role, content}}`, its
 * content a string or blocks (`text`, `thinking`, `tool_use`, and a
 * `tool_result` answering a `tool_use` by its id). They are folded into the
 * entries a session's transcript holds and then into its rows
 * (`transcriptRows`), so a renderer draws them as it draws the session:
 *
 * - **each prompt** (a user message with words) opens a run of its own, so the
 *   calls after it are one row at its first, as a run's are;
 * - **reasoning and replies** stand where they were said;
 * - **a call** ends `ok`, or `error` when its result says so, with the
 *   result as its output; with no result yet it is still running;
 * - **anything else**, a message of another type or a block of another kind,
 *   is one row naming it (ADR 0001).
 *
 * No run of the session holds these entries, so no turn row closes them.
 * Pure.
 */

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** A content block as the provider wrote it: only its `type` is relied on. */
type Block = Readonly<Record<string, unknown>>;

/** A message's content as blocks: a string is one text block. */
const blocksOf = (message: unknown): readonly Block[] => {
  const content = typeof message === "object" && message !== null ? (message as { readonly content?: unknown }).content : undefined;
  if (typeof content === "string") return content.length === 0 ? [] : [{ type: "text", text: content }];
  return Array.isArray(content) ? content.filter((block): block is Block => typeof block === "object" && block !== null) : [];
};

const words = (value: unknown): string => (typeof value === "string" ? value : "");

/** The rows a subagent's stored messages draw, oldest first. */
export const subagentRows = (messages: readonly JsonObject[]): readonly TranscriptRow[] => {
  const items: TranscriptEntry[] = [];
  const calls = new Map<string, Mutable<ToolCallEntry>>();
  let runs = 0;
  let runId = "subagent-run-0";
  // Each entry its own place, so no two rows share one (a message can hold several blocks).
  let sequence = 0;
  const opaque = (at: number, type: string, payload: unknown): OpaqueEntry => ({ kind: "opaque", sequence: at, type, payload });

  messages.forEach((stored, index) => {
    const id = typeof stored["uuid"] === "string" ? stored["uuid"] : `subagent-message-${String(index + 1)}`;
    const blocks = blocksOf(stored["message"]);
    if (stored["type"] === "user") {
      for (const block of blocks) {
        if (block["type"] !== "tool_result") continue;
        const call = calls.get(words(block["tool_use_id"]));
        if (call === undefined) continue;
        call.status = block["is_error"] === true ? "error" : "ok";
        call.output = (block["content"] ?? null) as ToolCallEntry["output"];
      }
      const text = blocks
        .filter((block) => block["type"] === "text")
        .map((block) => words(block["text"]))
        .join("\n\n");
      if (text.trim().length === 0) return;
      runId = `subagent-run-${String(++runs)}`;
      items.push({ kind: "user-message", sequence: ++sequence, runId, messageId: id, text, attachments: [], delivery: "prompt", heldBy: null, sentAt: words(stored["timestamp"]) });
      return;
    }
    if (stored["type"] !== "assistant") {
      items.push(opaque(++sequence, typeof stored["type"] === "string" ? stored["type"] : "message", stored));
      return;
    }
    blocks.forEach((block, at) => {
      const itemId = `${id}:${String(at)}`;
      if (block["type"] === "text" || block["type"] === "thinking") {
        const text = words(block["type"] === "text" ? block["text"] : block["thinking"]);
        items.push({ kind: block["type"] === "text" ? "assistant-text" : "assistant-thinking", sequence: ++sequence, runId, itemId, text, aborted: false, streaming: false });
      } else if (block["type"] === "tool_use") {
        const call: Mutable<ToolCallEntry> = {
          kind: "tool-call",
          sequence: ++sequence,
          runId,
          toolCallId: words(block["id"]) || itemId,
          name: words(block["name"]) || "tool",
          input: (typeof block["input"] === "object" && block["input"] !== null ? block["input"] : {}) as JsonObject,
          title: null,
          agentId: null,
          parentToolCallId: null,
          status: "running",
          update: null,
          output: null,
          durationMs: null,
          decision: null,
        };
        calls.set(call.toolCallId, call);
        items.push(call);
      } else {
        items.push(opaque(++sequence, typeof block["type"] === "string" ? block["type"] : "block", block));
      }
    });
  });
  return transcriptRows({ items, runs: [] });
};
