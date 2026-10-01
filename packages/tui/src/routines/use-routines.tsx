import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { useEffect, useMemo, type ReactElement } from "react";
import { formatDuration, type Clock, type EnvironmentView, type RoutineRow, type RoutinesView, type Runtime } from "@agent-harness/client-runtime";
import { EndpointName, ROUTINE_HISTORY_MAX, type KeyActionId, type RoutineEntry } from "@agent-harness/contracts";
import { TERMINAL_ROLES } from "@agent-harness/theme";
import { expandHome } from "../composer/attachments.js";
import type { ExternalEditResult } from "../composer/external-editor.js";
import type { Handler } from "../keys.js";
import { LinesPanel, ListCard, TypedLine, wrappedRows } from "../pickers/cards.js";
import { useFollow, type Opened } from "../session/use-session.js";
import { messageOf, nameOf, type Question } from "../view.js";
import {
  endpointRows,
  entryLines,
  firstLines,
  historyRows,
  importLines,
  listRows,
  preCheckWords,
  type AddingEndpoint,
  type ListRow,
  type RoutineListCard,
  type RoutineRef,
  type RoutinesCard,
} from "./cards.js";
import type { RoutineKey, RoutinesCommand } from "./commands.js";
import { routineSaver } from "./saving.js";

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

/** The routine `/routines test-precheck` names, ignoring case: on the header's environment first, then in the connection list's order. */
const routineNamed = (view: RoutinesView, name: string, preferred: string | undefined): RoutineRow | undefined => {
  const wanted = name.trim().replace(/\s+/g, " ").toLowerCase();
  const rows = [...view.groups.filter((group) => group.environmentId === preferred), ...view.groups.filter((group) => group.environmentId !== preferred)].flatMap((group) => group.routines);
  return rows.find((row) => row.definition.name.toLowerCase() === wanted);
};

/** A pre-check's test shows this many lines of its output. */
const TESTED_OUTPUT_LINES = 12;

/** The newest firing among `entries`, newest first: a skip has no session. */
const newestFiring = (entries: readonly RoutineEntry[]) => entries.find((entry) => entry.kind === "firing");

export const useRoutines = (host: RoutinesHost): Routines => {
  const { runtime, request, card } = host;
  useFollow(card !== undefined ? runtime.projections.routines : undefined, request);
  const now = host.clock.now();
  // The history shown, followed while its card is open: its newest page from the request cache, each older one as the cursor reaches it.
  const shownRoutine = card?.kind === "history" ? card.routine : undefined;
  const history = useMemo(
    () => (shownRoutine ? runtime.projections.routineHistory(shownRoutine.environmentId, shownRoutine.routineId) : undefined),
    [runtime, shownRoutine?.environmentId, shownRoutine?.routineId],
  );
  useFollow(history, request);
  const entries = () => history?.read().entries ?? [];
  // The endpoints shown, followed while their card is open: fetched again on routine.endpoint-set and -removed.
  const endpointsOf = card?.kind === "endpoints" ? card.environmentId : undefined;
  const endpointList = useMemo(() => (endpointsOf !== undefined ? runtime.requests.cached(endpointsOf, "routines.endpoints.list", {}) : undefined), [runtime, endpointsOf]);
  useFollow(endpointList, request);
  const endpoints = () => endpointList?.read().result?.endpoints ?? [];
  const list = (): readonly ListRow[] => listRows(runtime.projections.routines.read(), now);

  /** The routine under the list's cursor; none on an environment that lists none. */
  const routineAt = (shown: RoutineListCard): RoutineRow | undefined => {
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

  const confirmed = (text: string): Promise<boolean> => new Promise((settle) => host.ask({ text, yes: () => settle(true), no: () => settle(false) }));

  const saver = routineSaver({
    runtime,
    cwd: host.cwd,
    current: () => host.current,
    environmentName,
    say: host.say,
    confirm: confirmed,
    open: host.open,
    close: host.close,
    newRoutineId: host.newRoutineId,
    editYaml: host.editYaml,
  });

  /** A routines card being typed into: the list's export, or the endpoint being added. */
  const typing = (shown: RoutinesCard): boolean => (shown.kind === "list" && shown.exporting !== null) || (shown.kind === "endpoints" && shown.adding !== null);

  const changeAdding = (update: (adding: AddingEndpoint) => AddingEndpoint | null) =>
    host.change((shown) => (shown.kind === "endpoints" && shown.adding !== null ? { ...shown, adding: update(shown.adding) } : shown));

  /** `routines.endpoints.set`, an `admin` command sent directly: the endpoint with its URL, and a pasted secret when one was typed. */
  const setEndpoint = async (environmentId: string, adding: AddingEndpoint, secret: string) => {
    const answer = await runtime.requests.call(environmentId, "routines.endpoints.set", {
      commandId: host.newCommandId(),
      name: adding.name,
      url: adding.url,
      ...(secret !== "" && { secret: { kind: "pasted" as const, secret } }),
    });
    const refused = !answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : null;
    if (refused !== null) return changeAdding((held) => ({ ...held, error: `Not saved: ${refused}` }));
    changeAdding(() => null);
    host.say(`Saved the endpoint ${adding.name} on ${environmentName(environmentId)}.`);
  };

  /** Enter while an endpoint is being added: its name, then its URL, then its secret, which saves it. */
  const addStep = (environmentId: string, adding: AddingEndpoint) => {
    const text = adding.step === "secret" ? adding.text : adding.text.trim();
    if (adding.step === "name") {
      if (!EndpointName.safeParse(text).success) return changeAdding((held) => ({ ...held, error: "A name is 1 to 40 lower-case letters, digits and hyphens." }));
      return changeAdding((held) => ({ ...held, step: "url", name: text, text: "", error: null }));
    }
    if (adding.step === "url") {
      if (text === "") return changeAdding((held) => ({ ...held, error: "Type the URL its posts go to." }));
      return changeAdding((held) => ({ ...held, step: "secret", url: text, text: "", error: null }));
    }
    void setEndpoint(environmentId, adding, text);
  };

  /** `t`: `routines.endpoints.test`, a signed test posted to the endpoint, and what it came to. */
  const testEndpoint = async (environmentId: string, name: string) => {
    host.say(`Posting a test to ${name}…`);
    const answer = await runtime.requests.call(environmentId, "routines.endpoints.test", { name });
    if (!answer.ok) return host.say(`Not tested: ${answer.error.message}`);
    const { status, durationMs, error } = answer.result;
    host.say(error === null ? `${name} answered ${status ?? "nothing"} in ${formatDuration(durationMs)}.` : `${name} did not take the test: ${error}`);
  };

  /** `d`: `routines.endpoints.remove`, once confirmed. */
  const removeEndpoint = async (environmentId: string, name: string) => {
    const where = environmentName(environmentId);
    if (!(await confirmed(`Remove the endpoint ${name} from ${where}? A routine delivering to it shows it missing. y/n`))) return;
    const answer = await runtime.requests.call(environmentId, "routines.endpoints.remove", { commandId: host.newCommandId(), name });
    const refused = !answer.ok ? answer.error.message : answer.result.receipt.status === "rejected" ? answer.result.receipt.error.message : null;
    host.say(refused === null ? `Removed the endpoint ${name} from ${where}.` : `Not removed: ${refused}`);
  };

  /** The endpoint under the endpoints card's cursor, while nothing is typed into it. */
  const endpointOn = () => (card?.kind === "endpoints" && card.adding === null ? endpoints()[clamp(card.cursor, endpoints().length)] : undefined);

  /** `routines.testPreCheck` of the routine found, a query at `runs:drive`, never queued. */
  const testPreCheck = async (routine: RoutineRef) => {
    const answer = await runtime.requests.call(routine.environmentId, "routines.testPreCheck", { routineId: routine.routineId });
    host.change((shown) => (shown.kind === "precheck" ? (answer.ok ? { ...shown, record: answer.result } : { ...shown, failed: `Not run: ${answer.error.message}` }) : shown));
  };

  // `/routines test-precheck <name>`: once the lists are read, the routine named, and its pre-check run once.
  const finding = card?.kind === "precheck" && card.routine === null ? card.name : null;
  useEffect(() => {
    if (finding === null) return;
    const view = runtime.projections.routines.read();
    const found = routineNamed(view, finding, host.current?.environmentId);
    if (found) {
      const routine = refOf(found);
      host.change((shown) => (shown.kind === "precheck" ? { ...shown, routine } : shown));
      void testPreCheck(routine);
      return;
    }
    if (view.groups.some((group) => group.fetchedAt === null && group.error === null)) return;
    host.close();
    host.say(`No routine is named ${finding}.`);
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
      case "history":
        return entries().length;
      case "endpoints":
        return endpoints().length;
      case "import":
      case "precheck":
        return 0;
    }
  };

  /** The cursor moved to the history's last entry reads the page before it. */
  const moved = (shown: RoutinesCard, cursor: number): RoutinesCard => {
    if (shown.kind === "history" && cursor >= entries().length - 1) void history?.more();
    return { ...shown, cursor };
  };

  const routines: Routines = {
    run(command) {
      switch (command.name) {
        case "list":
          return host.open({ kind: "list", cursor: 0, exporting: null });
        case "new":
          return void saver.create();
        case "import":
          return void saver.importFile(command.path);
        case "endpoints": {
          const view = host.current;
          if (!view) return host.say("There is no environment whose endpoints to show: /pair one first.");
          return host.open({ kind: "endpoints", environmentId: view.environmentId, cursor: 0, adding: null });
        }
        case "test-precheck":
          return host.open({ kind: "precheck", name: command.routine, routine: null, record: null, failed: null, cursor: 0 });
      }
    },
    rows: rowsOf,
    move: (shown, step) => moved(shown, clamp(shown.cursor + step, rowsOf(shown))),
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
        case "history": {
          const entry = entries()[clamp(shown.cursor, entries().length)];
          if (entry?.kind === "firing") return openFiring(shown.routine.environmentId, entry.sessionId);
          if (entry) host.say("A skip has no session: the due time was skipped before one started.");
          return;
        }
        case "endpoints":
          if (shown.adding !== null) addStep(shown.environmentId, shown.adding);
          return;
        case "import":
        case "precheck":
          return;
      }
    },
    back(shown) {
      if (shown.kind === "history") return shown.back;
      if (shown.kind === "list" && shown.exporting !== null) return { ...shown, exporting: null };
      if (shown.kind === "endpoints" && shown.adding !== null) return { ...shown, adding: null };
      return null;
    },
    takesText: typing,
    typed(shown, text) {
      const clean = text.replace(/[\r\n]/g, "");
      if (shown.kind === "list" && shown.exporting !== null) return { ...shown, exporting: { ...shown.exporting, text: shown.exporting.text + clean, error: null } };
      if (shown.kind === "endpoints" && shown.adding !== null) return { ...shown, adding: { ...shown.adding, text: shown.adding.text + clean, error: null } };
      return shown;
    },
    erased(shown) {
      const drop = (text: string) => [...text].slice(0, -1).join("");
      if (shown.kind === "list" && shown.exporting !== null) return { ...shown, exporting: { ...shown.exporting, text: drop(shown.exporting.text) } };
      if (shown.kind === "endpoints" && shown.adding !== null) return { ...shown, adding: { ...shown.adding, text: drop(shown.adding.text) } };
      return shown;
    },
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
      "routines.history": () => {
        const row = verbOn();
        if (!row || card?.kind !== "list") return false;
        host.open({ kind: "history", routine: refOf(row), cursor: 0, back: card });
      },
      "routines.export": () => {
        const row = verbOn();
        if (!row || card?.kind !== "list") return false;
        host.change((shown) => (shown.kind === "list" ? { ...shown, exporting: { routine: refOf(row), text: exportFile(row.definition.name), error: null } } : shown));
      },
      "routines.edit": () => {
        const row = verbOn();
        if (!row) return false;
        void saver.edit(refOf(row));
      },
      "routines.endpoint.add": () => {
        if (card?.kind !== "endpoints" || card.adding !== null) return false;
        host.change((shown) => (shown.kind === "endpoints" ? { ...shown, adding: { step: "name", name: "", url: "", text: "", error: null } } : shown));
      },
      "routines.endpoint.test": () => {
        const endpoint = endpointOn();
        if (!endpoint || card?.kind !== "endpoints") return false;
        void testEndpoint(card.environmentId, endpoint.name);
      },
      "routines.endpoint.remove": () => {
        const endpoint = endpointOn();
        if (!endpoint || card?.kind !== "endpoints") return false;
        void removeEndpoint(card.environmentId, endpoint.name);
      },
    },
    hint(shown) {
      const k = host.keys;
      if (shown.kind === "history") return `${k("picker.move")} move · ${k("picker.choose")} opens its firing · ${k("picker.leave")} back`;
      if (shown.kind === "import" || shown.kind === "precheck") return `${k("picker.leave")} close`;
      if (shown.kind === "endpoints") return shown.adding !== null ? `${k("picker.choose")} ${shown.adding.step === "secret" ? "saves it" : "next"} · ${k("picker.leave")} leaves it` : `${k("picker.move")} move · ${k("picker.leave")} close`;
      if (shown.exporting !== null) return `${k("picker.choose")} exports it · ${k("picker.leave")} leaves it`;
      return `${k("picker.move")} move · ${k("picker.choose")} opens its latest firing · ${k("picker.leave")} close`;
    },
    render(shown, size) {
      if (shown.kind === "precheck") {
        const { record, routine } = shown;
        const lines = shown.failed
          ? [[{ text: shown.failed, color: TERMINAL_ROLES.danger }]]
          : record === null
            ? [[{ text: routine === null ? `Finding ${shown.name}…` : "Running its pre-check once: it records nothing…", dim: true }]]
            : [
                [{ text: preCheckWords(record), ...(record.failure !== null && { color: TERMINAL_ROLES.danger }) }],
                ...(record.output === null || record.output === "" ? [] : [[], ...firstLines(record.output, TESTED_OUTPUT_LINES)]),
                ...(record.stderr === null ? [] : [[], ...firstLines(record.stderr, TESTED_OUTPUT_LINES).map((line) => line.map((span) => ({ ...span, dim: true })))]),
              ];
        return <LinesPanel title={`Pre-check of ${routine?.name ?? shown.name}${routine ? ` on ${environmentName(routine.environmentId)}` : ""}`} hint={routines.hint(shown)} lines={lines} />;
      }
      if (shown.kind === "endpoints") {
        const read = endpointList?.read();
        const all = endpoints();
        const { adding } = shown;
        const held = adding !== null && all.some((endpoint) => endpoint.name === adding.name);
        const prompt =
          adding === null ? "" : adding.step === "name" ? "Name (lower-case letters, digits and hyphens):" : adding.step === "url" ? "URL:" : `Secret, pasted (Enter ${held ? "keeps the one held" : "for none"}):`;
        const text = adding === null ? "" : adding.step === "secret" ? "•".repeat([...adding.text].length) : adding.text;
        const k = host.keys;
        return (
          <ListCard
            width={size.width}
            title={`Webhook endpoints on ${environmentName(shown.environmentId)}`}
            hint={routines.hint(shown)}
            rows={endpointRows(all, now)}
            cursor={clamp(shown.cursor, all.length)}
            height={size.height}
            empty={read?.error ? `Not listed: ${read.error.message}` : read?.fetchedAt == null ? "Reading the endpoints…" : `No endpoints yet: ${k("routines.endpoint.add")} adds one.`}
            footer={[
              [],
              [{ text: `${k("routines.endpoint.add")} add · ${k("routines.endpoint.test")} test · ${k("routines.endpoint.remove")} remove`, dim: true }],
              ...(adding?.error ? [[{ text: adding.error, color: TERMINAL_ROLES.danger }]] : []),
            ]}
            childRows={adding === null ? 0 : wrappedRows(`${prompt} ${text} `, size.width)}
          >
            {adding !== null && <TypedLine prompt={prompt} text={text} />}
          </ListCard>
        );
      }
      if (shown.kind === "import") {
        const refused = shown.documents.length === 0 || shown.documents.some((document) => document.issues.length > 0);
        return (
          <LinesPanel
            title={`Import from ${shown.path} to ${environmentName(shown.environmentId)}`}
            hint={routines.hint(shown)}
            lines={importLines(shown.documents)}
            after={refused ? [[], [{ text: shown.documents.length === 0 ? "There is no routine document in it." : "Nothing is imported until the file's issues are fixed.", dim: true }]] : []}
          />
        );
      }
      if (shown.kind === "history") {
        const read = history?.read();
        const all = read?.entries ?? [];
        const cursor = clamp(shown.cursor, all.length);
        const at = all[cursor];
        return (
          <ListCard
            width={size.width}
            title={`History of ${shown.routine.name} on ${environmentName(shown.routine.environmentId)}`}
            hint={routines.hint(shown)}
            rows={read ? historyRows(read, now) : []}
            cursor={cursor}
            height={size.height}
            empty={read?.error ? `Not read: ${read.error.message}` : read?.fetchedAt == null ? "Reading its history…" : "It has not fired or skipped a due time yet."}
            footer={[...(at ? entryLines(at) : []), ...(read?.loading && all.length > 0 ? [[{ text: "Reading older entries…", dim: true }]] : [])]}
          />
        );
      }
      const rows = list();
      const { exporting } = shown;
      const prompt = exporting === null ? "" : `Export ${exporting.routine.name} to:`;
      const k = host.keys;
      const verbs = `${k("routines.runNow")} run now · ${k("routines.enable")} enable or disable · ${k("routines.history")} history · ${k("routines.edit")} edit · ${k("routines.export")} export`;
      return (
        <ListCard
          width={size.width}
          title="Routines"
          hint={routines.hint(shown)}
          rows={rows.map((row) => row.panel)}
          cursor={clamp(shown.cursor, rows.length)}
          height={size.height}
          empty="No environment is enabled: /environment lists them."
          footer={[
            [],
            [{ text: `${verbs} · /routines new · /routines import <path> · /routines endpoints`, dim: true }],
            ...(exporting?.error ? [[{ text: exporting.error, color: TERMINAL_ROLES.danger }]] : []),
          ]}
          childRows={exporting === null ? 0 : wrappedRows(`${prompt} ${exporting.text} `, size.width)}
        >
          {exporting !== null && <TypedLine prompt={prompt} text={exporting.text} />}
        </ListCard>
      );
    },
  };
  return routines;
};
