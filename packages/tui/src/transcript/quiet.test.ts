import type { ToolCallEntry } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { TOOL_QUIET_MS } from "./lines.js";
import { hear, nextQuietChange, quietFor } from "./quiet.js";

/** How long a running call has been quiet, measured on this terminal's clock (docs/specs/tui.md, "The transcript"). */

const running = (toolCallId: string, update: Record<string, unknown> | null = null): ToolCallEntry => ({
  kind: "tool-call",
  sequence: 1,
  runId: "run",
  toolCallId,
  name: "Bash",
  input: {},
  title: null,
  agentId: null,
  parentToolCallId: null,
  status: "running",
  update: update as ToolCallEntry["update"],
  output: null,
  durationMs: null,
  decision: null,
});

describe("hearing running calls", () => {
  it("counts a call's silence from when it was first heard, and again from each change of its update", () => {
    let heard = hear(new Map(), [running("a")], 1000);
    expect(quietFor(heard, "a", 61_000)).toBe(60_000);
    heard = hear(heard, [running("a")], 61_000);
    expect(quietFor(heard, "a", 61_000)).toBe(60_000);
    heard = hear(heard, [running("a", { progress: 1 })], 70_000);
    expect(quietFor(heard, "a", 71_000)).toBe(1000);
  });

  it("lets a call go once it is not running, and answers the same state when nothing changed", () => {
    const heard = hear(new Map(), [running("a")], 0);
    expect(hear(heard, [running("a")], 5)).toBe(heard);
    expect(quietFor(hear(heard, [], 5), "a", 10)).toBe(0);
  });

  it("wakes the screen when a call turns amber, then each minute after", () => {
    const heard = hear(new Map(), [running("a")], 0);
    expect(nextQuietChange(heard, 1000)).toBe(TOOL_QUIET_MS);
    expect(nextQuietChange(heard, TOOL_QUIET_MS + 10)).toBe(TOOL_QUIET_MS + 60_000);
    expect(nextQuietChange(new Map(), 0)).toBeUndefined();
  });
});
