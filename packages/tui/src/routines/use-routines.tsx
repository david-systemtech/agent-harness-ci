import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ReactElement } from "react";
import type { Clock, EnvironmentView, RoutineRow, Runtime } from "@agent-harness/client-runtime";
import { ROUTINE_HISTORY_MAX, type KeyActionId, type RoutineEntry } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { expandHome } from "../composer/attachments.js";
import type { ExternalEditResult } from "../composer/external-editor.js";
import type { Handler } from "../keys.js";
import { ListCard, TypedLine, wrappedRows } from "../pickers/cards.js";
import { useFollow, type Opened } from "../session/use-session.js";
import { messageOf, nameOf, type Question } from "../view.js";
import { listRows, type ListRow, type RoutineRef, type RoutinesCard } from "./cards.js";
import type { RoutineKey, RoutinesCommand } from "./commands.js";

/**
 * The routines card's hook (docs/specs/tui.md, "The routines"; #533): it
 * follows what the open card shows (`projections.routines`, a routine's
 * `projections.routineHistory`, the endpoints' cached list), runs what the
 * keys choose, and lends the terminal to the editor for an edit. The
 * runtime answers who may do what: a `sessions:write` command goes through
 * the outbox (`commands.dispatch`), which queues it while its environment
 * cannot be reached; run now, a `runs:drive` command, is refused at once
 * then; the queries and the `admin` calls are direct (`requests.call`).
 */

export interface RoutinesHost {
  readonly runtime: Runtime;
  readonly clock: Clock;
  readonly request: () => void;
  readonly views: readonly EnvironmentView[];
  /** The header's environment: whose endpoints `/routines endpoints` shows, and where a new routine or an import goes. */
  readonly current: EnvironmentView | undefined;
  /** The open card, when it is the routines card. */
  readonly card: RoutinesCard | undefined;
  open(card: RoutinesCard): void;
  /** Changes the open card while it is still the routines card. */
  change(update: (card: RoutinesCard) => RoutinesCard): void;
  close(): void;
  say(line: string): void;
  ask(question: Question): void;
  openSession(opened: Opened): void;
  newCommandId(): string;
  /** Mints a routine's id for a new routine or an import: a version 4 UUID. */
  newRoutineId(): string;
  keys(action: KeyActionId): string;
  /** The routine's YAML in `$VISUAL` or `$EDITOR`, with the terminal lent to it. */
  editYaml(yaml: string): Promise<ExternalEditResult>;
  /** Where a relative path typed for an export or an import is read from. */
  readonly cwd: string;
}

export interface Routines {
  run(command: RoutinesCommand): void;
  /** How many rows the card's list has. */
  rows(card: RoutinesCard): number;
  move(card: RoutinesCard, step: number): RoutinesCard;
  /** Enter. */
  choose(card: RoutinesCard): void;
  /** Esc: the card to go back to, or null to close it. */
  back(card: RoutinesCard): RoutinesCard | null;
  /** The card takes what is typed as text (a path, an endpoint's name, URL or secret). */
  takesText(card: RoutinesCard): boolean;
  typed(card: RoutinesCard, text: string): RoutinesCard;
  erased(card: RoutinesCard): RoutinesCard;
  readonly handlers: Readonly<Record<RoutineKey, Handler>>;
  hint(card: RoutinesCard): string;
  render(card: RoutinesCard, size: { readonly width: number; readonly height: number }): ReactElement;
}

const clamp = (cursor: number, rows: number): number => (rows <= 0 ? 0 : Math.min(Math.max(cursor, 0), rows - 1));

const refOf = (row: RoutineRow): RoutineRef => ({ environmentId: row.environmentId, routineId: row.routineId, name: row.definition.name });

/** The file an export of `name` is offered: its name in lower case, a hyphen for each run of anything else, `.yaml`. */
const exportFile = (name: string): string => `${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "routine"}.yaml`;

/** The newest firing among `entries`, newest first: a skip has no session. */
const newestFiring = (entries: readonly RoutineEntry[]) => entries.find((entry) => entry.kind === "firing");

export const useRoutines = (host: RoutinesHost): Routines => {
  const { runtime, request, card } = host;
  useFollow(card !== undefined ? runtime.projections.routines : undefined, request);
  const now = host.clock.now();
  const list = (): readonly ListRow[] => listRows(runtime.projections.routines.read(), now);

  /** The routine under the list's cursor; none on an environment that lists none. */
  const routineAt = (shown: Extract<RoutinesCard, { kind: "list" }>): RoutineRow | undefined => {
    const rows = list();
    const at = rows[clamp(shown.cursor, rows.length)];
    return at?.kind === "routine" ? at.row : undefined;
  };

  /** A firing's session, opened in place of the card. */
  const openFiring = (environmentId: string, sessionId: string) => {
    host.close();
    host.openSession({ environmentId, sessionId });
  };

  /**
   * Enter on a routine: its live firing's session, else its newest firing's
   * in its history, read whole (500 entries, the most a page holds), or as
   * the request cache last held it while its environment cannot be reached.
   */
  const openLatest = async (routine: RoutineRef, row: RoutineRow) => {
    const live = row.listed?.state.liveFiring;
    if (live) return openFiring(routine.environmentId, live.sessionId);
    const answer = await runtime.requests.call(routine.environmentId, "routines.history", { routineId: routine.routineId, limit: ROUTINE_HISTORY_MAX });
    const entries = answer.ok ? answer.result.entries : runtime.projections.routineHistory(routine.environmentId, routine.routineId).read().entries;
    const firing = newestFiring(entries);
    if (firing?.kind === "firing") return openFiring(routine.environmentId, firing.sessionId);
    if (!answer.ok && entries.length === 0) return host.say(`Not opened: ${answer.error.message}`);
    host.say(entries.length < ROUTINE_HISTORY_MAX ? `${routine.name} has not fired yet.` : `${routine.name} has not fired in its latest ${ROUTINE_HISTORY_MAX} due times.`);
  };

  const environmentName = (environmentId: string): string => {
    const view = host.views.find((v) => v.environmentId === environmentId);
    return view ? nameOf(view) : "its environment";
  };

  /** The verb's routine: the one under the list's cursor, while the list is the card shown and nothing is typed into it. */
  const verbOn = (): RoutineRow | undefined => (card?.kind === "list" && card.exporting === null ? routineAt(card) : undefined);

  /** A routine command through the outbox: refused at dispatch, it says why in one line, as nothing else will; a refusal after it was kept is its notice's. */
  const send = (routine: RoutineRef, method: "routines.enable" | "routines.disable", verb: string) =>
    void runtime.commands.dispatch(routine.environmentId, method, { routineId: routine.routineId }).then((answer) => {
      if (!answer.ok && answer.commandId === null) host.say(`Not ${verb}: ${answer.error.message}`);
    });

  /** `r`: run now never waits in the outbox, so it is refused at once while the environment cannot be reached. */
  const runNow = (routine: RoutineRef) =>
    void runtime.commands.dispatch(routine.environmentId, "routines.runNow", { routineId: routine.routineId }).then((answer) => {
      if (answer.ok) return host.say(`Running ${routine.name} on ${environmentName(routine.environmentId)} now.`);
      const firing = answer.error.code === "conflict" && answer.error.data?.["reason"] === "firing_running";
      host.say(firing ? `Not run: ${routine.name} is firing already.` : `Not run: ${answer.error.message}`);
    });

  /** The export typed: the routine's YAML as its environment exports it, written to the path, relative to the working directory. */
  const exportTo = async (routine: RoutineRef, typed: string) => {
    const path = resolve(host.cwd, expandHome(typed.trim(), homedir()));
    const answer = await runtime.requests.call(routine.environmentId, "routines.export", { routineIds: [routine.routineId] });
    const failed = (line: string) => host.change((shown) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, error: line } } : shown));
    if (!answer.ok) return failed(`Not exported: ${answer.error.message}`);
    try {
      await writeFile(path, answer.result.yaml, "utf8");
    } catch (error) {
      return failed(`Not written: ${messageOf(error)}`);
    }
    host.change((shown) => (shown.kind === "list" ? { ...shown, exporting: null } : shown));
    host.say(`Exported ${routine.name} to ${path}.`);
  };

  const rowsOf = (shown: RoutinesCard): number => {
    switch (shown.kind) {
      case "list":
        return list().length;
    }
  };

  const routines: Routines = {
    run(command) {
      switch (command.name) {
        case "list":
          return host.open({ kind: "list", cursor: 0, exporting: null });
        default:
          return host.say(`/routines ${command.name} is not in this build yet.`);
      }
    },
    rows: rowsOf,
    move: (shown, step) => ({ ...shown, cursor: clamp(shown.cursor + step, rowsOf(shown)) }),
    choose(shown) {
      switch (shown.kind) {
        case "list": {
          if (shown.exporting !== null) {
            if (shown.exporting.text.trim() !== "") void exportTo(shown.exporting.routine, shown.exporting.text);
            return;
          }
          const row = routineAt(shown);
          if (row) void openLatest(refOf(row), row);
          return;
        }
      }
    },
    back: (shown) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: null } : null),
    takesText: (shown) => shown.kind === "list" && shown.exporting !== null,
    typed: (shown, text) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, text: shown.exporting.text + text.replace(/[\r\n]/g, ""), error: null } } : shown),
    erased: (shown) => (shown.kind === "list" && shown.exporting !== null ? { ...shown, exporting: { ...shown.exporting, text: [...shown.exporting.text].slice(0, -1).join("") } } : shown),
    handlers: {
      "routines.runNow": () => {
        const row = verbOn();
        if (!row) return false;
        runNow(refOf(row));
      },
      "routines.enable": () => {
        const row = verbOn();
        if (!row) return false;
        if (row.definition.enabled) send(refOf(row), "routines.disable", "disabled");
        else send(refOf(row), "routines.enable", "enabled");
      },
      "routines.history": () => false,
      "routines.export": () => {
        const row = verbOn();
        if (!row || card?.kind !== "list") return false;
        host.change((shown) => (shown.kind === "list" ? { ...shown, exporting: { routine: refOf(row), text: exportFile(row.definition.name), error: null } } : shown));
      },
      "routines.edit": () => false,
      "routines.endpoint.add": () => false,
      "routines.endpoint.test": () => false,
      "routines.endpoint.remove": () => false,
    },
    hint: () => `${host.keys("picker.move")} move · ${host.keys("picker.leave")} close`,
    render(shown, size) {
      const rows = list();
      const { exporting } = shown;
      const prompt = exporting === null ? "" : `Export ${exporting.routine.name} to:`;
      return (
        <ListCard
          width={size.width}
          title="Routines"
          hint={routines.hint(shown)}
          rows={rows.map((row) => row.panel)}
          cursor={clamp(shown.cursor, rows.length)}
          height={size.height}
          empty="No environment is enabled: /environment lists them."
          footer={exporting?.error ? [[{ text: exporting.error, color: TERMINAL_ROLES.danger }]] : []}
          childRows={exporting === null ? 0 : wrappedRows(`${prompt} ${exporting.text} `, size.width)}
        >
          {exporting !== null && <TypedLine prompt={prompt} text={exporting.text} />}
        </ListCard>
      );
    },
  };
  return routines;
};
