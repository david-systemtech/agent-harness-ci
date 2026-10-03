import { describe, expect, it } from "vitest";
import type { RunSummary } from "@agent-harness/contracts";
import { contextOf } from "./context.js";

const run = (more: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run-1", state: "running", origin: "client", accountId: "account-1", identity: null,
  model: "model-a", effort: null, mode: { requested: null, effective: "auto", clamped: false },
  promptMessageId: null, queuedMessageIds: [], startedAt: "2026-10-03T00:00:00.000Z", endedAt: null,
  reason: null, cause: null, error: null, usage: null, durationMs: null, ...more,
});
const known = { id: "model-a", family: "a", tier: 1, label: null, efforts: [], contextWindow: 1000 };
const read = (runs: RunSummary[], more = {}) => contextOf({ supported: true, runs, model: "model-a", accountId: "account-1", models: [known], ...more });

describe("current context", () => {
  it("keeps before-run unknown and shows known zero only after a run starts", () => {
    expect(read([])).toMatchObject({ tokens: null, window: 1000, percent: null });
    expect(read([run()])).toMatchObject({ tokens: 0, window: 1000, percent: 0 });
    expect(read([run()], { models: [] })).toMatchObject({ tokens: null, window: null, percent: null });
  });
  it("uses the actual request model ahead of next-run choices and clamps the share", () => {
    expect(read([run({ context: { model: "model-b", contextTokens: 1200, contextWindow: 1000 } })])).toMatchObject({ model: "model-b", tokens: 1200, percent: 100 });
  });
  it("learns only denominators reported for the same model and account", () => {
    const earlier = run({ context: { model: "model-b", contextTokens: 500, contextWindow: 2000 } });
    const latest = run({ model: "model-b", context: { model: "model-b", contextTokens: 200, contextWindow: null } });
    expect(read([earlier, latest])).toMatchObject({ window: 2000, percent: 10 });
    expect(read([run({ ...latest, contextWindows: { "model-b": 2000 } })])).toMatchObject({ window: 2000, percent: 10 });
    expect(read([earlier, run({ model: "model-c" })])).toMatchObject({ window: null, percent: null });
    expect(read([run({ model: "constructor", contextWindows: { "model-b": 2000 } })])).toMatchObject({ window: null, percent: null });
    expect(read([run({ ...earlier, accountId: "other" }), latest])).toMatchObject({ window: null, percent: null });
  });
  it("keeps spend separate, reports unknown scale and exposes missing capability", () => {
    expect(read([run({ context: { model: "model-b", contextTokens: 400, contextWindow: null } })])).toMatchObject({ tokens: 400, window: null, percent: null });
    const spend = { model: "model-a", inputTokens: 9000, outputTokens: 500, cacheReadTokens: 4000, cacheWriteTokens: 0, costUsd: null, contextWindow: 1000 };
    expect(read([run({ usage: [spend] })])).toMatchObject({ tokens: null, window: 1000, percent: null });
    expect(read([run({ usage: [spend], context: { model: "model-a", contextTokens: 300, contextWindow: null } })])).toMatchObject({ tokens: 300, window: 1000, percent: 30 });
    expect(read([run()], { supported: false })).toMatchObject({ supported: false, tokens: null, percent: null });
  });
});
