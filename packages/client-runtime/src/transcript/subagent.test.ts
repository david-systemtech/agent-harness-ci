import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "./rows.js";
import { subagentRows } from "./subagent.js";

/**
 * A subagent's own transcript as the transcript's rows (docs/specs/gui.md,
 * "The seven panes and the grid": the Tasks pane opens each agent's
 * transcript): `sessions.subagentTranscript` answers the provider's stored
 * messages, which this folds into the entries the session's transcript
 * holds, so a renderer draws them as it draws the session. Pure.
 */

/** Claude's stored messages for a subagent, as the SDK answers them: its prompt, its reasoning, text and calls, their results. */
const EXPLORE = [
  { type: "user", uuid: "u1", message: { role: "user", content: "Find where the parser lives" } },
  {
    type: "assistant",
    uuid: "a1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Look under src first." },
        { type: "text", text: "Searching." },
        { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "parse" } },
      ],
    },
  },
  { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "src/parser.ts" }] } },
  { type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/parser.ts" } }] } },
  { type: "user", uuid: "u3", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "EACCES" }], is_error: true }] } },
  { type: "assistant", uuid: "a3", message: { role: "assistant", content: [{ type: "text", text: "It lives in src/parser.ts." }] } },
];

/** What a row draws, in a word or two: its kind and its text or its calls with how each ended. */
const read = (row: TranscriptRow): string => {
  switch (row.kind) {
    case "user":
      return `user: ${row.entry.text}`;
    case "assistant":
      return `${row.entry.kind}: ${row.entry.text}`;
    case "calls":
      return `calls: ${row.calls.map((call) => `${call.name} ${call.status}`).join(", ")}`;
    case "opaque":
      return `opaque: ${row.entry.type}`;
    default:
      return row.kind;
  }
};

describe("subagentRows", () => {
  it("draws the agent's prompt, reasoning and replies where they were said, and its calls in one row at its first, each with how it ended", () => {
    expect(subagentRows(EXPLORE).map(read)).toEqual([
      "user: Find where the parser lives",
      "assistant-thinking: Look under src first.",
      "assistant-text: Searching.",
      "calls: Grep ok, Read error",
      "assistant-text: It lives in src/parser.ts.",
    ]);
    const calls = subagentRows(EXPLORE)[3];
    expect(calls?.kind === "calls" && calls.calls.map((call) => [call.input, call.output])).toEqual([
      [{ pattern: "parse" }, "src/parser.ts"],
      [{ file_path: "src/parser.ts" }, [{ type: "text", text: "EACCES" }]],
    ]);
  });

  it("keeps a call with no result yet running, and gives each prompt the calls after it a row of their own", () => {
    const rows = subagentRows([
      { type: "user", message: { content: [{ type: "text", text: "First" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "a.ts" }] } },
      { type: "user", message: { content: "Now the tests" } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "pnpm test" } }] } },
    ]);
    expect(rows.map(read)).toEqual(["user: First", "calls: Bash ok", "user: Now the tests", "calls: Bash running"]);
  });

  it("keeps what it cannot show as one row naming it: a message of another type, a block of another kind", () => {
    const rows = subagentRows([
      { type: "system", subtype: "compact_boundary" },
      { type: "assistant", message: { content: [{ type: "redacted_thinking", data: "…" }, { type: "server_tool_use" }, { type: "text", text: "Done." }] } },
      { message: "no type at all" },
    ]);
    expect(rows.map(read)).toEqual(["opaque: system", "opaque: redacted_thinking", "opaque: server_tool_use", "assistant-text: Done.", "opaque: message"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("draws nothing for an agent with no transcript stored", () => {
    expect(subagentRows([])).toEqual([]);
  });
});
