import { followDraft, type InStep, type SessionProjection } from "@agent-harness/client-runtime";
import { useEffect, useRef } from "react";
import { useRuntime } from "../window-context.js";
import type { Box } from "./box.js";
import { slashWord } from "./menus.js";
import { typedCommand } from "./slash-commands.js";

/**
 * The box's text as the session's draft (docs/specs/gui.md, "A session
 * pane"), kept in step by the runtime's rule (`followDraft`) after every
 * render: saved through `drafts.set` a second after the last key, taken when
 * the session opens, and another client's taken only while nothing was typed
 * over what this composer held. A slash command being typed (one word after
 * a `/`, the menu's text) or a command of the window's with what follows it
 * is sent nowhere as a message, so it is never saved.
 */
export const useSessionDraft = (environmentId: string, sessionId: string, projection: SessionProjection, box: Box): void => {
  const runtime = useRuntime();
  const inStep = useRef<InStep | undefined>(undefined);
  useEffect(() => {
    const text = box.current();
    const step = followDraft(inStep.current, {
      session: `${environmentId} ${sessionId}`,
      held: projection.summary === null ? undefined : (projection.draft ?? ""),
      text,
      saves: slashWord(text, text.length) === undefined && typedCommand(text) === undefined,
    });
    inStep.current = step.inStep;
    if (step.take !== undefined) box.put(step.take);
    if (step.save !== undefined) runtime.drafts.set(environmentId, sessionId, step.save.length > 0 ? step.save : null);
  });
};
