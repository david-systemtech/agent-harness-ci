import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { uuidv4, type CommandParams, type DispatchAnswer, type EnvironmentView, type Runtime, type SessionRow } from "@agent-harness/client-runtime";
import type { CommandMethodName, KeyActionId } from "@agent-harness/contracts";
import { direction, keysText, type Handler, type Keymap } from "../keys.js";
import type { Presentation } from "../presentation.js";
import { messageOf, nameOf } from "../view.js";
import { badgesOf } from "./badge.js";
import { RAIL_KEYS, railUsage, type RailCommand, type RailKey } from "./commands.js";
import { groupHeading, headingOver, isFolded, isSelectable, railLines, rowKey, type RailHeading, type RailInput, type RailLine, type RailRow } from "./model.js";
import type { Picker } from "./picker.js";
import { cwdPicker, groupPicker, restorePicker, searchPicker, snoozePicker, snoozeTyped, startPicker, tagPicker, titleOf, whenBack, type RailActs } from "./pickers.js";
import { movesFor } from "./reorder.js";

/**
 * The rail's controller (docs/specs/tui.md, "The rail"): what the cursor is
 * on, the filter being typed, which rows this terminal is waiting on, and
 * what each of the rail's keys and slash forms does. The rail holds no
 * state of the environment's: its lines are `railLines` over the runtime's
 * projections, worked out again when one of them changes, and its keys
 * issue the session-state commands through the outbox (`commands.dispatch`,
 * `commands.moveToGroup`), whose overlay shows the effect at once. The only
 * state it keeps is client-local: the cursor, the filter, and the fold per
 * heading name (`collapsedHeadings`, in the presentation module).
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
  readonly keymap: Keymap;
  readonly presentation: Presentation;
  readonly startingService: boolean;
  /** The environment the header is about: where `/cwd` starts a session. */
  readonly current: EnvironmentView | undefined;
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
  /** What the keys do at the cursor, for the line under the composer. */
  readonly hint: string | undefined;
}

/** Why a shelf has no manual order: the reorder keys answer absent with it. */
const unordered = (kind: "snoozed" | "settled" | "archived"): string =>
  kind === "snoozed"
    ? "the snoozed shelf has no manual order; it is sorted by wake time"
    : kind === "settled"
      ? "the settled shelf has no manual order; it is sorted by when each settled, newest first"
      : "the archive has no manual order; it is sorted by when each was archived, newest first";

export const useRail = (options: RailOptions): Rail => {
  const { runtime, views, keymap, presentation, say, startingService } = options;
  const [cursor, setCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  // Rows a command sent from here waits on: their line shows `pending` until the answer, whatever the connection's phase.
  const [waiting, setWaiting] = useState<ReadonlyMap<string, number>>(new Map());
  const lastAt = useRef(0);
  // The filter as it is now, for what lands after this frame (a session accepted later).
  const filterNow = useRef(filter);
  filterNow.current = filter;
  const folded = useSyncExternalStore(presentation.collapsedHeadings.subscribe, presentation.collapsedHeadings.read);
  // Read as drawn (the screen's frame scheduler follows the list and asks for the frame), and worked out again only
  // when the list, the environments, the folds, the filter or what this terminal waits on changes.
  const list = runtime.projections.sessionList.read();
  const query = filter?.trim() ?? "";
  const badges = useMemo(() => badgesOf(views), [views]);
  const input: RailInput = useMemo(
    () => ({
      list,
      environments: views,
      badges,
      folded,
      matches: query === "" ? null : new Set(runtime.projections.search(query).read().map(rowKey)),
      unconfirmed: new Set(waiting.keys()),
      startingService,
      now: (environmentId) => runtime.environmentNow(environmentId),
    }),
    [runtime, list, views, badges, folded, query, waiting, startingService],
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

  const mark = (key: string | null, by: 1 | -1) => {
    if (key === null) return;
    setWaiting((current) => {
      const next = new Map(current);
      const count = (next.get(key) ?? 0) + by;
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  };
  /** Waits on a dispatched command: the line pending until its answer; a refusal before it was kept said here, a rejection after it the runtime's notice. */
  const track = <A extends DispatchAnswer<CommandMethodName>>(key: string | null, answer: Promise<A>, done?: (accepted: Extract<A, { readonly ok: true }>) => void) => {
    mark(key, 1);
    void answer.then(
      (settled) => {
        mark(key, -1);
        if (settled.ok) done?.(settled as Extract<A, { readonly ok: true }>);
        else if (settled.commandId === null) say(settled.error.message);
      },
      (error: unknown) => {
        mark(key, -1);
        say(messageOf(error));
      },
    );
  };

  /** Folds or opens a heading; the folds of groups no longer listed are dropped as the choice is kept. */
  const setFolded = (key: string, fold: boolean) => {
    const groups = new Set(runtime.projections.sessionList.read().groups.map((group) => groupHeading(group.key)));
    presentation.setFolded(key, fold, (heading) => !heading.startsWith(groupHeading("")) || groups.has(heading));
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
    badges,
    workspace: options.workspace,
    say,
    send: (environmentId, key, method, params, said, done) => {
      say(said);
      track(key, runtime.commands.dispatch(environmentId, method, params), done);
    },
    move: (row, name, said) => {
      say(said);
      track(rowKey(row), runtime.commands.moveToGroup(row.environmentId, row.summary.id, name));
    },
    reveal,
    land: (key) => {
      if (filterNow.current === null) setCursor(key);
    },
    newId: options.newId ?? uuidv4,
  };
  const send = <N extends CommandMethodName>(row: SessionRow, method: N, params: CommandParams<N>, verb: string) =>
    acts.send(row.environmentId, rowKey(row), method, params, `${verb} ${titleOf(row)}${whenBack(acts, row.environmentId)}.`);

  const archive = (row: SessionRow) =>
    row.summary.archivedAt === null
      ? send(row, "sessions.archive", { sessionId: row.summary.id }, "Archived")
      : send(row, "sessions.unarchive", { sessionId: row.summary.id }, "Took out of the archive");
  const pin = (row: SessionRow) =>
    row.summary.pinnedAt === null ? send(row, "sessions.pin", { sessionId: row.summary.id }, "Pinned") : send(row, "sessions.unpin", { sessionId: row.summary.id }, "Unpinned");
  const settle = (row: SessionRow) =>
    row.summary.settledAt === null ? send(row, "sessions.settle", { sessionId: row.summary.id }, "Settled") : send(row, "sessions.unsettle", { sessionId: row.summary.id }, "Unsettled");
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
    if (block.kind !== "pinned" && block.kind !== "active") return say(`${moving} is absent here: ${unordered(block.kind)}.`);
    // The neighbours a move goes between may be rows the filter hides: a move waits for every row to be in sight.
    if (input.matches !== null) return say(`${moving} is absent while the filter hides rows: ${keysText(keymap, "rail.leave")} clears it.`);
    const index = block.rows.findIndex((r) => rowKey(r) === rowKey(row));
    const pinned = block.kind === "pinned";
    const answer = movesFor(block.rows, index, step, (r) => (pinned ? r.summary.pinOrderKey : r.summary.activeOrderKey));
    if ("edge" in answer) return say(`${titleOf(row)} is already at the ${answer.edge} of ${pinned ? "the pinned sessions" : "its heading"}.`);
    say(`Moved ${titleOf(row)} ${step < 0 ? "up" : "down"}${whenBack(acts, row.environmentId)}.`);
    for (const move of answer.moves) {
      const key = `${move.environmentId}/${move.sessionId}`;
      const params = { sessionId: move.sessionId, orderKey: move.key };
      track(key, pinned ? runtime.commands.dispatch(move.environmentId, "sessions.reorderPinned", params) : runtime.commands.dispatch(move.environmentId, "sessions.reorderActive", params));
    }
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
    options.open(startPicker(acts, view));
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
    const usage = railUsage(command);
    if (usage !== undefined) return say(usage);
    const { name, text } = command;
    if (name === "search") return options.open(searchPicker(acts, text));
    if (name === "restore") return options.open(restorePicker(acts, text));
    if (name === "cwd") {
      const view = options.current;
      if (!view || view.name === null) return say("There is no environment to start a session on: /pair one first.");
      return options.open(cwdPicker(acts, view, text));
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
        return acts.send(row.environmentId, rowKey(row), "sessions.rename", { sessionId: row.summary.id, title: text }, `Titled ${titleOf(row)} “${text}”${whenBack(acts, row.environmentId)}.`);
      case "tag":
        return acts.send(row.environmentId, rowKey(row), "sessions.tag", { sessionId: row.summary.id, tag: text }, `Tagged ${titleOf(row)} #${text}${whenBack(acts, row.environmentId)}.`);
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
