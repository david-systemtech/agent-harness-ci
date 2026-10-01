import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  arrange,
  isFolded,
  keepsFold,
  noManualOrder,
  organiseUsage,
  rowKey,
  stepIn,
  toggleOf,
  uuidv4,
  type CommandParams,
  type DispatchAnswer,
  type DispatchFailure,
  type EnvironmentView,
  type Runtime,
  type SessionRow,
} from "@agent-harness/client-runtime";
import type { CommandMethodName, KeyActionId } from "@agent-harness/contracts";
import { direction, keysText, type Handler, type Keymap } from "../keys.js";
import type { Presentation } from "../presentation.js";
import type { ThemeColours } from "../theme/colours.js";
import { messageOf, nameOf } from "../view.js";
import { badgesOf } from "./badge.js";
import { RAIL_KEYS, type RailCommand, type RailKey } from "./commands.js";
import { headingOver, isSelectable, railLines, type RailHeading, type RailInput, type RailLine, type RailRow } from "./model.js";
import type { Picker } from "./picker.js";
import { newSessionCard, type CardOpening } from "./new-session.js";
import { groupPicker, restorePicker, searchPicker, snoozePicker, snoozeTyped, tagPicker, titleOf, whenBack, type RailActs } from "./pickers.js";
import { setWorkspacePicker } from "./workspace-step.js";

/**
 * The rail's controller (docs/specs/tui.md, "The rail"): what the cursor is
 * on, the filter being typed, and what each of the rail's keys and slash
 * forms does. The rail holds no state of the environment's: its lines are
 * `railLines` over the runtime's projections, worked out again when one of
 * them changes, and its keys issue the session-state commands through the
 * outbox (`commands.dispatch`, `commands.moveToGroup`), whose overlay shows
 * the effect at once and whose entries mark the rows they are about until
 * their receipt (`awaitingReceipt`). The only state it keeps is
 * client-local: the cursor, the filter, and the fold per heading name
 * (`collapsedHeadings`, in the presentation module).
 */

/** A yes or no question on the line above the composer (the `confirm` context). */
export interface RailQuestion {
  readonly text: string;
  readonly yes: () => void;
  readonly no?: () => void;
}

export interface RailOptions {
  readonly runtime: Runtime;
  readonly views: readonly EnvironmentView[];
  /** The colours the badges are drawn in: the theme's at this terminal's depth. */
  readonly colours: ThemeColours;
  readonly keymap: Keymap;
  readonly presentation: Presentation;
  readonly startingService: boolean;
  /**
   * What the new-session card opens on from the composer (`/cwd`, and `/new`
   * with no session open): the open session, else the environment
   * `--environment` names, else nothing in focus; with no session open, the
   * terminal's own directory as the workspace on the local environment.
   */
  readonly opening: () => CardOpening;
  /** The terminal's workspace (`--cwd`, else the current directory). */
  readonly workspace: string;
  /** The session a slash form acts on before the one under the cursor: the open session, once the transcript opens one. */
  readonly inHand?: { readonly environmentId: string; readonly sessionId: string } | undefined;
  /** A question stands on the line above the composer: the rail's keys wait for its answer. */
  readonly asked: boolean;
  /** Mints the id of a session the rail creates; preset, the runtime's `uuidv4`. */
  readonly newId?: () => string;
  say(line: string): void;
  ask(question: RailQuestion): void;
  /** Opens a picker as the screen's card. */
  open(picker: Picker): void;
  /** Closes the card when it still shows `picker` (a step whose session was made); leaves any other card. */
  close(picker: Picker): void;
  /** Opens a session in the transcript (Enter on its row). */
  openSession(target: { readonly environmentId: string; readonly sessionId: string }): void;
  /** Gives the rail the keys. */
  focus(): void;
  /** Gives the keys back to the composer. */
  leave(): void;
}

export interface Rail {
  readonly lines: readonly RailLine[];
  /** The key of the line under the cursor. */
  readonly cursor: string | null;
  /** What is typed after `/`; null while not filtering. */
  readonly filter: string | null;
  readonly handlers: Readonly<Record<RailKey, Handler>>;
  /** Printable text while the filter is being typed: taken into it. False when there is no filter to type into. */
  type(text: string): boolean;
  /** A rail slash command. */
  run(command: RailCommand): void;
  /** Opens the new-session card on `opening` (`/new` with no session open), or says why there is nowhere to start one. */
  newSession(opening: CardOpening): void;
  /** What the keys do at the cursor, for the line under the composer. */
  readonly hint: string | undefined;
}

export const useRail = (options: RailOptions): Rail => {
  const { runtime, views, keymap, presentation, say, startingService } = options;
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const lastAt = useRef(0);
  // The filter as it is now, for what lands after this frame (a session accepted later).
  const filterNow = useRef(filter);
  filterNow.current = filter;
  const folded = useSyncExternalStore(presentation.collapsedHeadings.subscribe, presentation.collapsedHeadings.read);
  // Read as drawn (the screen's frame scheduler follows the list and asks for the frame), and worked out again only
  // when the list, the environments, the folds or the filter changes.
  const list = runtime.projections.sessionList.read();
  const query = filter?.trim() ?? "";
  const badges = useMemo(() => badgesOf(views, options.colours), [views, options.colours]);
  const input: RailInput = useMemo(
    () => ({
      list,
      environments: views,
      badges,
      folded,
      matches: query === "" ? null : new Set(runtime.projections.search(query).read().map(rowKey)),
      startingService,
      now: (environmentId) => runtime.environmentNow(environmentId),
    }),
    [runtime, list, views, badges, folded, query, startingService],
  );
  const lines = useMemo(() => railLines(input), [input]);
  const selectable = lines.filter(isSelectable);
  // The cursor follows its line; a line gone (a row moved onto a folded shelf) leaves it where it was. A filter
  // just typed puts it on the first row it matches.
  const found = selectable.findIndex((line) => line.key === cursor);
  const firstRow = Math.max(0, selectable.findIndex((line) => line.kind === "row"));
  const at = found !== -1 ? found : cursor === null && input.matches !== null ? firstRow : Math.min(lastAt.current, Math.max(selectable.length - 1, 0));
  lastAt.current = at;
  const selected: RailHeading | RailRow | undefined = selectable[at];

  /**
   * Hears a dispatched command's answer: a refusal before it was kept said
   * here, a rejection after it the runtime's notice; `refused`, when given,
   * hears both instead.
   */
  const hear = <A extends DispatchAnswer<CommandMethodName>>(
    answer: Promise<A>,
    done?: (accepted: Extract<A, { readonly ok: true }>) => void,
    refused?: (failure: DispatchFailure) => void,
  ) => {
    void answer.then(
      (settled) => {
        if (settled.ok) done?.(settled as Extract<A, { readonly ok: true }>);
        else if (refused) refused(settled.error);
        else if (settled.commandId === null) say(settled.error.message);
      },
      (error: unknown) => say(messageOf(error)),
    );
  };

  /** Folds or opens a heading; the folds of groups no longer listed are dropped as the choice is kept. */
  const setFolded = (key: string, fold: boolean) => {
    presentation.setFolded(key, fold, keepsFold(runtime.projections.sessionList.read()));
  };

  const reveal = (key: string) => {
    // Opens the heading the row is under (a folded shelf, a folded group), clears the filter and puts the cursor on it.
    const over = headingOver({ ...input, list: runtime.projections.sessionList.read() }, key);
    if (over && over.folded !== null && isFolded(presentation.collapsedHeadings.read(), over.key)) setFolded(over.key, false);
    setFilter(null);
    setCursor(key);
    options.focus();
  };

  const acts: RailActs = {
    runtime,
    views,
    badge: (environmentId) => badgesOf(runtime.projections.environments.read(), options.colours).get(environmentId),
    workspace: options.workspace,
    say,
    send: (environmentId, method, params, said, done, refused) => {
      say(said);
      hear(runtime.commands.dispatch(environmentId, method, params), done, refused);
    },
    start: (environmentId, choice, said, done, refused) => {
      say(said);
      hear(
        runtime.commands.startSession(environmentId, choice).then((started) => started.answer),
        () => done?.(),
        refused,
      );
    },
    openSession: options.openSession,
    move: (row, name, said) => {
      say(said);
      hear(runtime.commands.moveToGroup(row.environmentId, row.summary.id, name));
    },
    reveal,
    close: options.close,
    land: (key) => {
      if (filterNow.current === null) setCursor(key);
    },
    newId: options.newId ?? uuidv4,
  };
  const send = <N extends CommandMethodName>(row: SessionRow, method: N, params: CommandParams<N>, verb: string) =>
    acts.send(row.environmentId, method, params, `${verb} ${titleOf(row)}${whenBack(acts, row.environmentId)}.`);

  // Each toggle's command as the session stands (the runtime's `toggleOf`), said in the rail's words.
  const archive = (row: SessionRow) => {
    const { method, on } = toggleOf(row.summary, "archive");
    send(row, method, { sessionId: row.summary.id }, on ? "Took out of the archive" : "Archived");
  };
  const pin = (row: SessionRow) => {
    const { method, on } = toggleOf(row.summary, "pin");
    send(row, method, { sessionId: row.summary.id }, on ? "Unpinned" : "Pinned");
  };
  const settle = (row: SessionRow) => {
    const { method, on } = toggleOf(row.summary, "settle");
    send(row, method, { sessionId: row.summary.id }, on ? "Unsettled" : "Settled");
  };
  const remove = (row: SessionRow) =>
    options.ask({
      text: `Delete ${titleOf(row)} on ${environmentName(row.environmentId)}? /restore brings it back within 30 days. y/n`,
      yes: () => send(row, "sessions.delete", { sessionId: row.summary.id }, "Deleted"),
      no: () => say("Not deleted."),
    });
  const environmentName = (environmentId: string) => {
    const view = views.find((v) => v.environmentId === environmentId);
    return view ? nameOf(view) : "its environment";
  };

  /** The session the cursor is on, or why there is none: every row key but the reorder keys needs one. */
  const onRow = (act: (row: SessionRow) => void): Handler => () => {
    if (selected?.kind !== "row") return say("Put the cursor on a session first.");
    act(selected.row);
  };

  const moveBy = (step: -1 | 1): Handler => () => {
    if (selected?.kind !== "row") return say("Put the cursor on a session first.");
    const { block, row } = selected;
    const moving = keysText(keymap, step < 0 ? "rail.moveUp" : "rail.moveDown");
    // The keys between the neighbours, spread when there is no room, are the runtime's (`stepIn`), as the window's drag sends them.
    const answer = stepIn(block, block.rows.findIndex((r) => rowKey(r) === rowKey(row)), step);
    if (!("edge" in answer) && answer.kind === "refused" && answer.why === "shelf") return say(`${moving} is absent here: ${noManualOrder(answer.shelf)}.`);
    // The neighbours a move goes between may be rows the filter hides: a move waits for every row to be in sight.
    if (input.matches !== null) return say(`${moving} is absent while the filter hides rows: ${keysText(keymap, "rail.leave")} clears it.`);
    if ("edge" in answer) return say(`${titleOf(row)} is already at the ${answer.edge} of ${block.kind === "pinned" ? "the pinned sessions" : "its heading"}.`);
    say(`Moved ${titleOf(row)} ${step < 0 ? "up" : "down"}${whenBack(acts, row.environmentId)}.`);
    void arrange(runtime.commands, answer).then((answers) => {
      for (const answered of answers) hear(Promise.resolve(answered));
    });
  };

  const step = (action: "rail.move" | "rail.moveVi"): Handler => (name) => {
    const by = direction(keymap, action, name);
    // From the cursor as it is when the key lands, so keys pressed faster than the frames all move it.
    setCursor((current) => {
      const from = selectable.findIndex((line) => line.key === current);
      const next = selectable[Math.min(Math.max((from === -1 ? at : from) + by, 0), Math.max(selectable.length - 1, 0))];
      return next ? next.key : current;
    });
  };

  const open = () => {
    if (!selected) return;
    if (selected.kind === "row") return options.openSession({ environmentId: selected.row.environmentId, sessionId: selected.row.summary.id });
    if (selected.folded !== null) return setFolded(selected.key, !selected.folded);
    const view = views.find((v) => v.environmentId === selected.environmentId);
    if (!view || view.name === null) return say("The environment on this machine has not answered yet: there is nowhere to start a session.");
    options.open(newSessionCard(acts, { focus: { kind: "environment", environmentId: view.environmentId } }));
  };

  /** The new-session card, on an environment this client knows; none known, and the line says so. */
  const newSession = (opening: CardOpening) => {
    if (!views.some((view) => view.name !== null)) return say("There is no environment to start a session on: /pair one first.");
    options.open(newSessionCard(acts, opening));
  };

  const own: Record<RailKey, Handler> = {
    "rail.move": step("rail.move"),
    "rail.moveVi": step("rail.moveVi"),
    "rail.open": open,
    "rail.filter": () => setFilter(""),
    "rail.filter.erase": () => {
      if (filter === null) return false;
      setCursor(selected?.key ?? null);
      // From the filter as it is when the key lands, so each of several fast presses rubs a letter off.
      setFilter((typed) => (typed === null || typed === "" ? null : [...typed].slice(0, -1).join("")));
    },
    "rail.leave": () => {
      if (filter === null) return options.leave();
      // The cursor stays on the row it was on as the rest come back.
      setCursor(selected?.key ?? null);
      setFilter(null);
    },
    "rail.archive": onRow(archive),
    "rail.delete": onRow(remove),
    "rail.pin": onRow(pin),
    "rail.archive.filtering": onRow(archive),
    "rail.delete.filtering": onRow(remove),
    "rail.pin.filtering": onRow(pin),
    "rail.settle": onRow(settle),
    "rail.snooze": onRow((row) => options.open(snoozePicker(acts, row))),
    "rail.tag": onRow((row) => options.open(tagPicker(acts, row))),
    "rail.group": onRow((row) => options.open(groupPicker(acts, row))),
    "rail.moveUp": moveBy(-1),
    "rail.moveDown": moveBy(1),
  };
  // While a question stands (the delete's confirm) the rail's keys wait for its answer, so no second command
  // goes out from under it; its own keys (`confirm`) are looked up before the rail's.
  const answerFirst: Handler = () => say(`The question waits: answer it first, ${keysText(keymap, "confirm.yes")} or ${keysText(keymap, "confirm.no")}.`);
  const handlers = options.asked ? (Object.fromEntries(RAIL_KEYS.map((id) => [id, answerFirst])) as Record<RailKey, Handler>) : own;

  /**
   * The session a slash form acts on: the open one, else the one the rail's
   * cursor was put on, while it is listed, even moved onto a folded shelf
   * (so `/settle` then `/archive` act on one session), else the one the
   * cursor is on now.
   */
  const inHand = (): SessionRow | undefined => {
    const wanted = options.inHand;
    if (wanted) return list.rows.find((row) => row.environmentId === wanted.environmentId && row.summary.id === wanted.sessionId);
    const put = cursor === null ? undefined : list.rows.find((row) => rowKey(row) === cursor);
    return put ?? (selected?.kind === "row" ? selected.row : undefined);
  };

  const run = (command: RailCommand) => {
    // The usage lines are the client runtime's, which the window's session pane says too.
    const usage = organiseUsage(command.name, command.text);
    if (usage !== undefined) return say(usage);
    const { name, text } = command;
    if (name === "search") return options.open(searchPicker(acts, text));
    if (name === "restore") return options.open(restorePicker(acts, text));
    if (name === "cwd") {
      // The open session's workspace is missing: the step gives it another (#328).
      const open = options.inHand && list.rows.find((row) => row.environmentId === options.inHand?.environmentId && row.summary.id === options.inHand.sessionId);
      const openView = open && views.find((v) => v.environmentId === open.environmentId);
      if (open && openView && open.summary.workspaceMissingSince !== null) return options.open(setWorkspacePicker(acts, openView, open, text));
      return newSession({ ...options.opening(), query: text });
    }
    const row = inHand();
    if (!row) return say(`/${name} acts on the session in hand: put the rail's cursor on one first.`);
    switch (name) {
      case "archive":
        return archive(row);
      case "pin":
        return pin(row);
      case "settle":
        return settle(row);
      case "title":
        return acts.send(row.environmentId, "sessions.rename", { sessionId: row.summary.id, title: text }, `Titled ${titleOf(row)} “${text}”${whenBack(acts, row.environmentId)}.`);
      case "tag":
        return acts.send(row.environmentId, "sessions.tag", { sessionId: row.summary.id, tag: text }, `Tagged ${titleOf(row)} #${text}${whenBack(acts, row.environmentId)}.`);
      case "group":
        return text === "" ? options.open(groupPicker(acts, row)) : acts.move(row, text, `Moved ${titleOf(row)} into ${text}${whenBack(acts, row.environmentId)}.`);
      case "snooze":
        return text === "" ? options.open(snoozePicker(acts, row)) : snoozeTyped(acts, row, text);
    }
  };

  const keys = (action: KeyActionId) => keysText(keymap, action);
  const atCursor =
    selected === undefined
      ? undefined
      : selected.kind === "row"
        ? `${keys("rail.open")} opens it · ${(["rail.archive", "rail.pin", "rail.delete", "rail.settle", "rail.snooze", "rail.tag", "rail.group"] as const).map(keys).join(" ")} act on it`
        : selected.folded === null
          ? views.some((v) => v.environmentId === selected.environmentId && v.name !== null)
            ? `${keys("rail.open")} starts a session on ${selected.text}`
            : undefined
          : `${keys("rail.open")} ${selected.folded ? "unfolds" : "folds"} ${selected.text}`;
  // The slash forms act on the session in hand, which is not the highlighted row once that row has moved away
  // (onto a folded shelf) or a session is open: the hint names it while they differ.
  const target = inHand();
  const elsewhere = target !== undefined && (selected?.kind !== "row" || rowKey(selected.row) !== rowKey(target)) ? `the slash forms act on ${titleOf(target)}` : undefined;
  const hint = atCursor !== undefined && elsewhere !== undefined ? `${atCursor} · ${elsewhere}` : (atCursor ?? elsewhere);

  return {
    lines,
    cursor: selected?.key ?? null,
    filter,
    handlers,
    newSession,
    type(text) {
      if (filter === null) return false;
      // As an update of the filter as it is, so keys that land before the next frame are all kept.
      setFilter((typed) => (typed === null ? typed : typed + text));
      setCursor(null);
      return true;
    },
    run,
    hint,
  };
};
