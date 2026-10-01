import { formatDuration, wakeWords, type RoutineGroup, type RoutineHistoryView, type RoutineRow, type RoutinesView } from "@agent-harness/client-runtime";
import {
  describeSchedule,
  type DeliveryTarget,
  type FiringFailureReason,
  type PreCheckRecord,
  type RoutineAttention,
  type RoutineDelivery,
  type RoutineEntry,
  type RoutineImportCheck,
  type RoutineLastOutcome,
  type RoutineWorkspace,
  type RoutineTrigger,
  type SkipReason,
} from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import type { PanelRow, Typed } from "../pickers/panel.js";
import type { Span } from "../transcript/lines.js";
import { pathWords } from "./document.js";
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

/** `/routines`: every environment's routines; `exporting`, the path an export is typed into. */
export interface ListCard {
  readonly kind: "list";
  readonly cursor: number;
  readonly exporting: (Typed & { readonly routine: RoutineRef }) | null;
}

export type RoutinesCard =
  | ListCard
  /** `h`: a routine's firings and skips, newest first, over the list it goes back to. */
  | { readonly kind: "history"; readonly routine: RoutineRef; readonly cursor: number; readonly back: ListCard }
  /** `/routines import <path>`: the file read, what `routines.checkImport` says of each document, until it is imported or left. */
  | { readonly kind: "import"; readonly environmentId: string; readonly path: string; readonly yaml: string; readonly documents: readonly RoutineImportCheck[]; readonly cursor: number };

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

/** What needs attention on a routine, in words; `failing` is the streak's, said beside it, and `clamped` names the mode. */
const ATTENTION_WORDS: Readonly<Record<RoutineAttention, string>> = {
  failing: "failing",
  clamped: "its mode clamped",
  account_missing: "no account here",
  account_signed_out: "account signed out",
  model_unavailable: "model unavailable",
  skill_unknown: "a skill is unknown",
  script_missing: "pre-check script missing",
  endpoint_missing: "an endpoint is missing",
  endpoint_needs_secret: "an endpoint needs its secret",
  delivery_failing: "a delivery failed",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** A time gone by, short, on this client's clock: its time on the day it is `now`, else its date and time. */
const pastWords = (iso: string, now: Date): string => {
  const at = new Date(iso);
  return at.toDateString() === now.toDateString() ? clockTime(iso) : `${at.getDate()} ${MONTHS[at.getMonth()] ?? ""} ${clockTime(iso)}`;
};

/** How the routine's latest entry ended, and when. */
const lastOutcomeWords = (last: RoutineLastOutcome | null, now: Date): string => {
  if (last === null) return "never fired";
  const when = pastWords(last.at, now);
  if (last.kind === "skip") return `last skipped ${when}: ${SKIP_WORDS[last.reason]}`;
  return last.reason === null ? `last ${last.outcome} ${when}` : `last ${last.outcome}: ${FAILURE_WORDS[last.reason]} ${when}`;
};

/** What the line under a routine says after its next firing: what needs attention, its streak, then its live firing or last outcome, the first in sight on a narrow card. */
const stateWords = (row: RoutineRow, now: Date): readonly string[] => {
  const { listed } = row;
  if (listed === null) return ["waiting to be created"];
  const { state, attention, mode } = listed;
  return [
    ...attention.flatMap((code) => (code === "failing" ? [] : code === "clamped" ? [`its mode clamped to ${mode.effective}`] : [ATTENTION_WORDS[code]])),
    ...(state.failureStreak > 0 ? [`${state.failureStreak} failed in a row`] : []),
    state.liveFiring !== null ? `firing since ${pastWords(state.liveFiring.startedAt, now)}` : lastOutcomeWords(state.lastOutcome, now),
  ];
};

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - [...text].length));

// An import ------------------------------------------------------------------------------------

/** A workspace as an import re-resolves it here. */
const workspaceWords = (workspace: RoutineWorkspace): string =>
  workspace.kind === "scratch" ? "a scratch directory" : workspace.kind === "directory" ? workspace.path : `a worktree of ${workspace.repository}`;

/** Each document of an import, as `routines.checkImport` read it: its name and schedule, its issues at their paths, what it would need here. */
export const importLines = (documents: readonly RoutineImportCheck[]): readonly (readonly Span[])[] =>
  documents.flatMap(({ index, definition, issues, warnings }) => [
    [
      { text: `${index + 1}. ${definition?.name ?? "Not a routine"}`, bold: true },
      ...(definition ? [{ text: `  ${describeSchedule({ schedule: definition.schedule, timezone: definition.timezone })}`, dim: true }] : []),
    ],
    ...issues.map((issue) => [{ text: `   ${issue.path.length === 0 ? "" : `${pathWords(issue.path)}: `}${issue.message.replace(/\s+/g, " ")}`, color: TERMINAL_ROLES.danger }]),
    ...(warnings.attention.length === 0 ? [] : [[{ text: `   Here it would need: ${warnings.attention.map((code) => ATTENTION_WORDS[code]).join(", ")}`, color: TERMINAL_ROLES.warning }]]),
    ...(warnings.workspace === null ? [] : [[{ text: `   Its workspace here: ${workspaceWords(warnings.workspace)}`, dim: true }]]),
  ]);

// A routine's history ---------------------------------------------------------------------------

const TRIGGER_WORDS: Readonly<Record<RoutineTrigger, string>> = { schedule: "on schedule", "catch-up": "caught up", "run-now": "run now" };

/** How an entry ended: a firing's outcome and why it failed, a skip's reason. */
const entryWords = (entry: RoutineEntry): string => {
  if (entry.kind === "skip") return `skipped: ${SKIP_WORDS[entry.reason]}`;
  if (entry.outcome === null) return "firing now";
  return entry.reason === null ? entry.outcome : `${entry.outcome}: ${FAILURE_WORDS[entry.reason]}`;
};

/** The history's rows, newest first: when, how it ended, then how it was triggered, the due times it stands for and how long it ran. */
export const historyRows = (view: RoutineHistoryView, now: Date): readonly PanelRow[] =>
  view.entries.map((entry) => {
    const when = pastWords(entry.kind === "firing" ? entry.startedAt : entry.at, now);
    const failed = entry.kind === "skip" ? entry.reason === "pre-check-failed" || entry.reason === "cannot-start" : entry.outcome === "failed";
    return {
      key: entry.id,
      cells: [{ text: pad(when, 14), dim: true }, { text: entryWords(entry), ...(failed && { color: TERMINAL_ROLES.danger }) }],
      dim: false,
      note: {
        text: [
          TRIGGER_WORDS[entry.trigger],
          ...(entry.count > 1 ? [`for ${entry.count} due times`] : []),
          ...(entry.kind === "firing" && entry.durationMs !== null ? [formatDuration(entry.durationMs)] : []),
        ].join(" · "),
        dim: true,
      },
    };
  });

/** At most this many lines of an entry's kept text, and of its pre-check's output, under the history. */
const KEPT_LINES = 6;
const OUTPUT_LINES = 4;

const firstLines = (text: string, most: number): (readonly Span[])[] => {
  const lines = text.replace(/\s+$/, "").split("\n");
  return [...lines.slice(0, most).map((line) => [{ text: line }]), ...(lines.length > most ? [[{ text: `… ${lines.length - most} more lines in its session`, dim: true }]] : [])];
};

/** A pre-check's run, in words: how it ended, how long it took, its output's size, and whether it differed from the baseline. */
const preCheckWords = (record: PreCheckRecord): string => {
  const ended =
    record.failure !== null
      ? `failed: ${record.failure.detail}`
      : record.kind === "script"
        ? `exited ${record.exitStatus ?? "?"}`
        : `answered ${record.httpStatus ?? "?"}`;
  const differs = record.differs === null ? "no baseline yet" : record.differs ? "changed" : "unchanged";
  return `${ended} in ${formatDuration(record.durationMs)}, ${record.bytes} bytes, ${differs}`;
};

const targetWords = (target: DeliveryTarget): string => (target.kind === "client-notice" ? "client notice" : target.target);

/** Where one delivery stands, the last attempt's status and error when it failed. */
const deliveryWords = (delivery: RoutineDelivery): string => {
  const last = delivery.attempts.at(-1);
  const attempts = delivery.attempts.length > 1 ? ` after ${delivery.attempts.length} attempts` : "";
  if (delivery.result !== "failed" || last === undefined) return `${targetWords(delivery.target)}: ${delivery.result}${attempts}`;
  const why = [last.status === null ? null : String(last.status), last.error].filter((part) => part !== null).join(" ");
  return `${targetWords(delivery.target)}: failed${why === "" ? "" : `, ${why}`}${attempts}`;
};

/** The entry at the history's cursor, under the list: its kept text (a skip's detail), its pre-check and its output, its deliveries. */
export const entryLines = (entry: RoutineEntry): readonly (readonly Span[])[] => {
  const kept =
    entry.kind === "skip"
      ? entry.detail === null
        ? []
        : firstLines(entry.detail, KEPT_LINES)
      : entry.text === null
        ? [[{ text: "Still firing: its text is kept when it ends.", dim: true }]]
        : entry.text.trim() === ""
          ? [[{ text: "Its run gave no final text.", dim: true }]]
          : firstLines(entry.text, KEPT_LINES);
  const preCheck = entry.preCheck;
  return [
    [],
    ...kept,
    ...(preCheck === null ? [] : [[{ text: `Pre-check: ${preCheckWords(preCheck)}`, dim: true }], ...(preCheck.output === null ? [] : firstLines(preCheck.output, OUTPUT_LINES).map((line) => line.map((span) => ({ ...span, dim: true }))))]),
    ...entry.deliveries.map((delivery) => [{ text: `Delivery to ${deliveryWords(delivery)}`, dim: delivery.result !== "failed", ...(delivery.result === "failed" && { color: TERMINAL_ROLES.danger }) }]),
  ];
};

/** An environment's heading: its name, how many routines it lists, and when its list is stale, when it was listed. */
const headingOf = (group: RoutineGroup): string => {
  const count = `${group.routines.length} routine${group.routines.length === 1 ? "" : "s"}`;
  const stale = group.stale && group.fetchedAt !== null ? ` · unreachable: as listed at ${clockTime(group.fetchedAt)}` : "";
  const failed = group.error !== null && !group.stale ? ` · not listed: ${group.error.message}` : "";
  const reading = group.fetchedAt === null && group.error === null ? " · reading…" : "";
  return `${group.name} · ${count}${stale}${failed}${reading}`;
};

/** The list's rows, each environment's under its heading: name, a command waiting and the schedule in words; under it, its next firing and its state. */
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
          cells: [
            { text: pad(definition.name, names), bold: true },
            ...(row.pending ? [{ text: "pending ", color: TERMINAL_ROLES.warning }] : []),
            { text: describeSchedule({ schedule: definition.schedule, timezone: definition.timezone ?? "its environment's zone" }) },
          ],
          dim: group.stale,
          under: { text: `    ${[next, ...words].join(" · ")}`, ...(attention ? { color: TERMINAL_ROLES.warning } : { dim: true }) },
          ...(at === 0 && { heading }),
        },
      };
    });
  });
};
