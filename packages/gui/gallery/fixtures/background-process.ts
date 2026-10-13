import type { DelegatedWorkRow, ProviderProcess } from "@agent-harness/contracts";

export const backgroundProcess = (sessionId: string, fields: Partial<ProviderProcess> = {}): ProviderProcess => ({
  sessionId, provider: "claude", state: "idle", runId: null,
  startedAt: "2026-09-23T23:48:00.000Z", lastBusyAt: "2026-09-23T23:49:00.000Z",
  parkedSince: null, holds: [1, 2, 3].map((id) => ({ kind: "task", id: `agent-${id}` })),
  stopsAt: null, stoppedAt: null, stopReason: null, ...fields,
});

export const backgroundAgents: readonly DelegatedWorkRow[] = [1, 2, 3].map((id) => ({
  taskId: `agent-${id}`, kind: "local_agent", description: `Check receipts ${id}`, subagentType: "Explore",
  status: "running", startedAt: "2026-09-23T23:48:00.000Z", endedAt: null, toolCallId: null, error: null,
}));
