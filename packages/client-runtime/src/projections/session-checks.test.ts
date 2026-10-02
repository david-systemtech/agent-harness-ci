import { describe, expect, it } from "vitest";
import { numbered } from "../../test/transcript.js";
import { reduceSession } from "./session.js";
import { transcriptRows } from "../transcript/rows.js";

const empty = { runs: [], items: [], parkedPrompts: [], rewinds: [], instructions: "" };
const started = { terminalId: "0199aa00-0000-4000-8000-000000000003", command: "pnpm test", sourceRunId: null };

describe("check result rows", () => {
  it("keeps one dollar-command row as a manual check runs, times out with truncated output, and replays", () => {
    const events = numbered(1, [["checks.started", started]]);
    const running = reduceSession(empty, events);
    expect(transcriptRows(running)).toMatchObject([{ kind: "check", entry: { command: "pnpm test", status: "running" } }]);
    events.push(...numbered(2, [["checks.finished", { ...started, output: "last output", truncated: true, exitCode: null, signal: null, timedOut: true, failure: null }]]));
    const finished = reduceSession(empty, events);
    expect(transcriptRows(finished)).toMatchObject([{ kind: "check", entry: { sequence: 1, status: "timeout", output: "last output", truncated: true, exitCode: null } }]);
    expect(reduceSession(empty, events).items).toEqual(finished.items);
  });
  it.each([[0, "pass"], [2, "failure"]])("renders exit %s as %s even when only the finished event is retained", (exitCode, status) => {
    const view = reduceSession(empty, numbered(4, [["checks.finished", { ...started, output: "result", truncated: false, exitCode, signal: null, timedOut: false, failure: null }]]));
    expect(view.items).toMatchObject([{ kind: "check", status, exitCode, output: "result" }]);
  });
});
