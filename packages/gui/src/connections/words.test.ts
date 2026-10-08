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

// A service stopped by hand drains like one restarting for an update; `updating` follows the environment's bye: updating,
// an update under way whether or not this window started it (#1838).
describe("a draining or updating environment", () => {
  it("is stopping while draining with no update under way", () => {
    expect(phaseSentence(desk("draining"), false, false, NOW)).toBe("desk is stopping…");
    expect(phaseWords(desk("draining"), false, false, NOW)).toBe("Stopping…");
  });

  it("is restarting for an update while updating for an update another client started", () => {
    expect(phaseSentence(desk("updating"), false, false, NOW)).toBe("desk is restarting for an update…");
    expect(phaseWords(desk("updating"), false, false, NOW)).toBe("Restarting for an update…");
  });

  it.each(["draining", "updating"] as const)("is restarting for an update while %s with one under way", (phase) => {
    expect(phaseSentence(desk(phase, RESTARTING), false, false, NOW)).toBe("Restarting for an update…");
    expect(phaseWords(desk(phase, RESTARTING), false, false, NOW)).toBe("Restarting for an update…");
  });
});
