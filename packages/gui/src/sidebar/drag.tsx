import { arrange, dropOnto, rowKey, type DropTarget, type SessionRow } from "@agent-harness/client-runtime";
import { useState, type DragEvent } from "react";
import { THIS_MACHINE } from "../connections/words.js";
import { useRuntime } from "../window-context.js";
import { useOrganise } from "./organise.js";
import { useDraggedRow } from "./window-sidebar.js";
import { refusalWords } from "./words.js";

/**
 * Dragging in the sidebar (docs/specs/gui.md, "The window and the sidebar";
 * #398). A row drags its session; what a drop onto a row or a heading sends
 * is the client runtime's plan (`dropOnto`, then `arrange`): within the
 * pinned block, or among a heading's active sessions, a key between the
 * drawn neighbours, spread when there is no room; onto a group, the session
 * moved into it; onto the pinned block, pinned. A shelf, another
 * environment's heading and a filtered list refuse it: nothing is sent, the
 * pointer shows no drop, and the sidebar's line says why. The session
 * dragged is held above the sidebar (`useDraggedRow`) and carried as
 * `SESSION_DRAG_TYPE` alone, so a drop elsewhere in the window reads it (the
 * pane grid, #407) and a text field it is dropped on takes nothing in.
 */

/** The drag data a session carries: its environment's id and its own, as JSON. */
export const SESSION_DRAG_TYPE = "application/x-agent-harness-session";

/** What a row's control takes to be dragged. */
export const useDragRow = (row: SessionRow) => {
  const [, setDragged] = useDraggedRow();
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify({ environmentId: row.environmentId, sessionId: row.summary.id }));
      event.dataTransfer.effectAllowed = "move";
      setDragged(row);
    },
    onDragEnd: () => setDragged(null),
  };
};

/** What a drop target takes: its handlers, and whether a session held over it now would be taken. */
export const useDropTarget = (target: DropTarget) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const [dragged, setDragged] = useDraggedRow();
  const [over, setOver] = useState(false);

  /** The dragged session as the list holds it now, and what dropping it here does; null while no session is dragged. */
  const planned = () => {
    if (dragged === null) return null;
    const row = runtime.projections.sessionList.read().rows.find((held) => rowKey(held) === rowKey(dragged)) ?? dragged;
    return { row, plan: dropOnto(row, target) };
  };
  const refusal = (row: SessionRow, plan: ReturnType<typeof dropOnto>) => {
    if (plan.kind !== "refused") return undefined;
    const name = runtime.projections.environments.read().find((view) => view.environmentId === row.environmentId)?.name ?? THIS_MACHINE;
    return refusalWords(plan, row.summary.title, name);
  };

  return {
    over,
    handlers: {
      onDragOver: (event: DragEvent) => {
        const held = planned();
        if (held === null) return;
        const refused = refusal(held.row, held.plan);
        // Refused, the pointer shows no drop and the line says why; nothing to change, it is left alone.
        if (refused !== undefined) organise.say(refused);
        if (held.plan.kind === "refused" || held.plan.kind === "unchanged") return setOver(false);
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        const held = planned();
        if (held === null) return;
        event.preventDefault();
        setOver(false);
        setDragged(null);
        const refused = refusal(held.row, held.plan);
        if (refused !== undefined) return organise.say(refused);
        organise.hear(arrange(runtime.commands, held.plan), "Not moved");
      },
    },
  };
};
