import { folded, transcriptRowTime } from "@agent-harness/client-runtime";
import { useCallback, useState } from "react";
import type { Drawn } from "../queue/placement.js";

/** Preceding visible clocks follow the presentation's tool folds, retaining the day across untimed rows. */
export const useRowTimes = (drawn: readonly Drawn[]) => {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const callsOpenChanged = useCallback((id: string, open: boolean) => {
    setExpanded(held => {
      if (held.has(id) === open) return held;
      const next = new Set(held);
      if (open) next.add(id); else next.delete(id);
      return next;
    });
  }, []);
  let previousTime: string | undefined;
  const previousTimes = drawn.map(item => {
    const before = previousTime;
    let time = item.kind === "row" ? transcriptRowTime(item.row) : item.message.sentAt;
    if (item.kind === "row" && item.row.kind === "calls") {
      const done = item.row.calls.filter(folded);
      const standing = item.row.calls.filter(call => !folded(call));
      time = standing.findLast(call => call.startedAt !== undefined)?.startedAt
        ?? (expanded.has(item.row.id) ? done.findLast(call => call.startedAt !== undefined)?.startedAt : done[0]?.startedAt);
    }
    if (time !== undefined) previousTime = time;
    return before;
  });
  return { previousTimes, callsOpenChanged };
};
