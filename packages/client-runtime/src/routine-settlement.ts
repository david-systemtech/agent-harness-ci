import type { ListedRoutine } from "@agent-harness/contracts";
import type { Observable } from "./observable.js";
import type { Commands } from "./outbox/outbox.js";
import type { RoutinesView } from "./projections/routines.js";
import type { Requests } from "./requests.js";

interface SettlementHost {
  readonly routines: Observable<RoutinesView>;
  readonly call: Requests["call"];
  readonly dispatch: Commands["dispatch"];
  readonly admits: Commands["admits"];
  report(error: unknown): void;
}

/** Only an active copy and its enabled, unedited, unlinked original can settle a move. */
const unsettled = (original: ListedRoutine, copy: ListedRoutine): boolean => {
  const link = copy.state.movedFrom;
  return link !== null && copy.definition.enabled && copy.state.movedTo === null && original.definition.enabled && original.state.movedTo === null
    && link.definitionSequence !== undefined && original.state.definitionSequence === link.definitionSequence;
};

/** While the routines view is followed, settlement follows both lists, rechecking over the wire before sending a disable once. */
export const createRoutineSettlement = (host: SettlementHost) => {
  const sent = new Set<string>();
  const checking = new Set<string>();
  let closed = false;
  const keyOf = (from: string, routineId: string, to: string, copyId: string) => `${from} ${routineId} ${to} ${copyId}`;
  const reserve = (from: string, routineId: string, to: string, copyId: string) => { sent.add(keyOf(from, routineId, to, copyId)); };
  const settle = async (from: string, routineId: string, to: string, copyId: string, key: string) => {
    try {
      const [source, target] = await Promise.all([host.call(from, "routines.list", {}), host.call(to, "routines.list", {})]);
      if (!source.ok || !target.ok || closed || sent.has(key)) return;
      const original = source.result.routines.find(r => r.state.id === routineId);
      const copy = target.result.routines.find(r => r.state.id === copyId);
      if (!original || !copy || !unsettled(original, copy) || host.admits(from, "routines.disable").status === "absent") return;
      reserve(from, routineId, to, copyId);
      await host.dispatch(from, "routines.disable", { routineId, movedTo: { environmentId: to, routineId: copyId } });
    } finally {
      checking.delete(key);
    }
  };
  const scan = (view: RoutinesView) => {
    if (closed) return;
    for (const group of view.groups) {
      if (group.stale) continue;
      for (const row of group.routines) {
        const copy = row.listed;
        const link = copy?.state.movedFrom;
        if (!copy || !link) continue;
        const source = view.groups.find(g => g.environmentId === link.environmentId && !g.stale);
        const original = source?.routines.find(r => r.routineId === link.routineId)?.listed;
        const key = keyOf(link.environmentId, link.routineId, group.environmentId, row.routineId);
        if (!original || !unsettled(original, copy) || checking.has(key) || sent.has(key) || host.admits(link.environmentId, "routines.disable").status === "absent") continue;
        checking.add(key);
        void settle(link.environmentId, link.routineId, group.environmentId, row.routineId, key).catch(host.report);
      }
    }
  };
  return {
    reserve,
    view: {
      read: () => host.routines.read(),
      subscribe(listener: (value: RoutinesView) => void) {
        const stop = host.routines.subscribe(value => { scan(value); listener(value); });
        scan(host.routines.read());
        return stop;
      },
    },
    close() { closed = true; },
  };
};
