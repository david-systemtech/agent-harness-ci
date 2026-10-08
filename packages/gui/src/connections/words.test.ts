import type { ConnectionPhase, EnvironmentView } from "@agent-harness/client-runtime";
import { describe, expect, it } from "vitest";
import { phaseSentence, phaseWords } from "./words.js";

const NOW = new Date("2026-10-08T12:00:00.000Z");

const desk = (phase: ConnectionPhase, update?: EnvironmentView["update"]): EnvironmentView => ({
  ...(update !== undefined && { update }),
  environmentId: "env-desk", kind: "local", primary: true, name: "desk", icon: null, colour: null, version: "0.6.0",
  flags: {} as EnvironmentView["flags"], scopes: [], ceiling: null, enabled: true, phase, blocked: null, retryAt: null,
  unreachableSince: null, refreshFailed: null, action: null, pendingCommands: 0,
});

const RESTARTING = { pending: null, error: null, restarting: true, canUpdateNow: false };

// A service stopped by hand drains like one restarting for an update: only an update the runtime knows of is said as one (#1838).
describe("a draining or updating environment", () => {
  it.each(["draining", "updating"] as const)("is stopping while %s with no update under way", (phase) => {
    expect(phaseSentence(desk(phase), false, false, NOW)).toBe("desk is stopping…");
    expect(phaseWords(desk(phase), false, false, NOW)).toBe("Stopping…");
  });

  it.each(["draining", "updating"] as const)("is restarting for an update while %s with one under way", (phase) => {
    expect(phaseSentence(desk(phase, RESTARTING), false, false, NOW)).toBe("Restarting for an update…");
    expect(phaseWords(desk(phase, RESTARTING), false, false, NOW)).toBe("Restarting for an update…");
  });
});
