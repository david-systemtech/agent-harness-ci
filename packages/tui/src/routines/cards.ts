import { wakeWords, type RoutineGroup, type RoutineRow, type RoutinesView } from "@agent-harness/client-runtime";
import { describeSchedule, type FiringFailureReason, type RoutineAttention, type RoutineLastOutcome, type SkipReason } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { PanelRow, Typed } from "../pickers/panel.js";
import { clockTime } from "../view.js";

/**
 * The routines card (docs/specs/tui.md, "The routines"; #533), as data:
 * what each of its cards is, and the rows and lines each draws from
 * `projections.routines` and the answers it read. Pure;
 * `use-routines.tsx` wires them to the runtime and the keys.
 */

/** A routine as a verb names it: where it is, its id and its name. */
export interface RoutineRef {
  readonly environmentId: string;
  readonly routineId: string;
  readonly name: string;
}

export type RoutinesCard =
  /** `/routines`: every environment's routines; `exporting`, the path an export is typed into. */
  { readonly kind: "list"; readonly cursor: number; readonly exporting: (Typed & { readonly routine: RoutineRef }) | null };

/** One row of the list: a routine, or an environment that lists none, which nothing can be done to. */
export type ListRow = { readonly kind: "routine"; readonly row: RoutineRow; readonly panel: PanelRow } | { readonly kind: "empty"; readonly panel: PanelRow };

const SKIP_WORDS: Readonly<Record<SkipReason, string>> = {
  "no-change": "no change",
  "pre-check-failed": "the pre-check failed",
  "cannot-start": "it could not start",
  missed: "missed",
  overlap: "the last was still firing",
};

const FAILURE_WORDS: Readonly<Record<FiringFailureReason, string>> = {
  run_error: "the run failed",
  timed_out: "timed out",
  restart: "the environment restarted",
  drained: "the environment drained",
};

/** What needs attention on a routine, in words; `failing` is the streak's, said beside it. */
const ATTENTION_WORDS: Readonly<Record<Exclude<RoutineAttention, "failing" | "clamped">, string>> = {
  account_missing: "no account here",
  account_signed_out: "account signed out",
  model_unavailable: "model unavailable",
  skill_unknown: "a skill is unknown",
  script_missing: "pre-check script missing",
  endpoint_missing: "an endpoint is missing",
  endpoint_needs_secret: "an endpoint needs its secret",
  delivery_failing: "a delivery failed",
};

/** How the routine's latest entry ended. */
export const lastOutcomeWords = (last: RoutineLastOutcome | null, now: Date): string => {
  if (last === null) return "never fired";
  const when = wakeWords(new Date(last.at), now);
  if (last.kind === "skip") return `last skipped ${when}: ${SKIP_WORDS[last.reason]}`;
  return last.reason === null ? `last ${last.outcome} ${when}` : `last ${last.outcome}: ${FAILURE_WORDS[last.reason]} ${when}`;
};

/** The line under a routine: what needs attention, its streak, then its live firing or last outcome; the first in sight on a narrow card. */
const stateWords = (row: RoutineRow, now: Date): readonly string[] => {
  const { listed } = row;
  if (listed === null) return ["waiting to be created"];
  const { state, attention, mode } = listed;
  return [
    ...attention.flatMap((code) => (code === "failing" ? [] : code === "clamped" ? [`its mode clamped to ${mode.effective}`] : [ATTENTION_WORDS[code]])),
    ...(state.failureStreak > 0 ? [`${state.failureStreak} failed in a row`] : []),
    state.liveFiring !== null ? `firing since ${clockTime(state.liveFiring.startedAt)}` : lastOutcomeWords(state.lastOutcome, now),
  ];
};

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - [...text].length));

/** An environment's heading: its name, how many routines it lists, and when its list is stale, when it was listed. */
const headingOf = (group: RoutineGroup): string => {
  const count = `${group.routines.length} routine${group.routines.length === 1 ? "" : "s"}`;
  const stale = group.stale && group.fetchedAt !== null ? ` · unreachable: as listed at ${clockTime(group.fetchedAt)}` : "";
  const failed = group.error !== null && !group.stale ? ` · not listed: ${group.error.message}` : "";
  const reading = group.fetchedAt === null && group.error === null ? " · reading…" : "";
  return `${group.name} · ${count}${stale}${failed}${reading}`;
};

/** The list's rows, each environment's under its heading: name, schedule in words, next firing; under it, its state. */
export const listRows = (view: RoutinesView, now: Date): readonly ListRow[] => {
  const names = Math.max(0, ...view.groups.flatMap((group) => group.routines.map((row) => [...row.definition.name].length))) + 2;
  return view.groups.flatMap((group): ListRow[] => {
    const heading = { text: headingOf(group), bold: true, ...(group.stale && { color: TERMINAL_ROLES.warning }) };
    if (group.routines.length === 0) {
      return [{ kind: "empty", panel: { key: `${group.environmentId} none`, cells: [{ text: group.fetchedAt === null ? "Reading its routines…" : "No routines." }], dim: true, heading } }];
    }
    return group.routines.map((row, at): ListRow => {
      const { definition, listed } = row;
      const next = !definition.enabled ? "disabled" : listed?.nextDueAt ? `next ${wakeWords(new Date(listed.nextDueAt), now)}` : "not due";
      const words = stateWords(row, now);
      const attention = (listed?.attention.length ?? 0) > 0;
      return {
        kind: "routine",
        row,
        panel: {
          key: `${row.environmentId} ${row.routineId}`,
          cells: [{ text: pad(definition.name, names), bold: true }, { text: describeSchedule({ schedule: definition.schedule, timezone: definition.timezone ?? "its environment's zone" }) }],
          dim: group.stale,
          note: { text: [next, ...(row.pending ? ["pending"] : [])].join(" · "), dim: !row.pending },
          under: { text: `    ${words.join(" · ")}`, ...(attention ? { color: TERMINAL_ROLES.warning } : { dim: true }) },
          ...(at === 0 && { heading }),
        },
      };
    });
  });
};
