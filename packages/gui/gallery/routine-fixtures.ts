import { RoutineDefinitionInput, type ListedRoutine } from "@agent-harness/contracts";

/** Neutral routine readings shared by the GUI harness and gallery. */
export const routineFixture = (name = "Morning digest", digit = 1): ListedRoutine => ({
  definition: { ...RoutineDefinitionInput.parse({ name, schedule: { kind: "daily", at: "09:00" }, timezone: "UTC", instructions: "Summarise the project updates.", workspace: { kind: "directory", path: "/projects/sample", repositoryIdentity: null }, account: null, model: null, effort: null, mode: null, containment: null, skills: [], preCheck: null, enabled: true }), timezone: "UTC" },
  state: { id: `10000000-0000-4000-8000-${String(digit).padStart(12, "0")}`, savedUnderCeiling: "acceptEdits", savedBy: "cs-test", createdAt: "2026-10-03T00:00:00.000Z", editedAt: null, movedFrom: null, movedTo: null, baseline: null, handledThrough: null, liveFiring: null, lastOutcome: { kind: "skip", entryId: "20000000-0000-4000-8000-000000000001", reason: "no-change", at: "2026-10-03T09:00:00.000Z" }, failureStreak: 0 },
  nextDueAt: "2026-10-04T09:00:00.000Z",
  mode: { requested: "acceptEdits", effective: "acceptEdits", ceiling: "acceptEdits", clamped: false, clampReason: null }, attention: [], unknownSkills: [],
});
