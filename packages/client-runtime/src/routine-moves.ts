import { documentOfDefinition, type ListedRoutine, type RoutineImportCheck } from "@agent-harness/contracts";
import type { CapabilityAnswer } from "./capabilities.js";
import { uuidv4 } from "./ids.js";
import type { Commands } from "./outbox/outbox.js";
import type { RequestFailure, Requests } from "./requests.js";

export type RoutineMoveResult = { readonly ok: true; readonly routineId: string } | { readonly ok: false; readonly error: RequestFailure };
export type RoutineMove =
  | { readonly ok: false; readonly error: RequestFailure }
  | {
      readonly ok: true;
      readonly documents: readonly RoutineImportCheck[];
      /** Imports only when confirmed. Repeated confirmations share the same operation. */
      confirm(): Promise<RoutineMoveResult>;
    };

export interface RoutineMoves {
  /** Whether the source can be moved: exported while reachable, otherwise from its cached definition, with disable permission. */
  routineMoveCapability(from: string, routineId: string): CapabilityAnswer;
  /** Prepares the target's checkImport confirmation; no mutation until confirm(). A name retries a taken name. */
  moveRoutine(from: string, routineId: string, to: string, name?: string): Promise<RoutineMove>;
}

interface MoveHost {
  readonly call: Requests["call"];
  readonly capability: (environmentId: string, method: "routines.export") => CapabilityAnswer;
  readonly admits: Commands["admits"];
  readonly dispatch: Commands["dispatch"];
  reserve(from: string, routineId: string, to: string, copyId: string): void;
  cached(environmentId: string, routineId: string): ListedRoutine | null;
}

export const createRoutineMoves = (host: MoveHost): RoutineMoves => {
  const routineMoveCapability = (from: string, routineId: string): CapabilityAnswer => {
    const disable = host.admits(from, "routines.disable");
    if (disable.status === "absent") return disable;
    const exported = host.capability(from, "routines.export");
    if (exported.status === "present") return exported;
    if (exported.reason !== "unreachable" && exported.reason !== "not-ready") return exported;
    return host.cached(from, routineId.toLowerCase()) !== null ? { status: "present" } : { status: "absent", reason: "unreachable", message: "The source cannot be reached and no cached definition is available." };
  };
  return {
    routineMoveCapability,
    async moveRoutine(from, routineId, to, name) {
      routineId = routineId.toLowerCase();
      const available = routineMoveCapability(from, routineId);
      if (available.status === "absent") return { ok: false, error: { code: available.reason, message: available.message } };
      const targetAdmits = host.admits(to, "routines.import");
      if (targetAdmits.status === "absent") return { ok: false, error: { code: targetAdmits.reason, message: targetAdmits.message } };
      if (from === to) return { ok: false, error: { code: "invalid_params", message: "Choose another environment." } };
      const exported = await host.call(from, "routines.export", { routineIds: [routineId] });
      let source = host.cached(from, routineId);
      if (exported.ok) {
        const listed = await host.call(from, "routines.list", {});
        if (!listed.ok) return listed;
        source = listed.result.routines.find(r => r.state.id === routineId) ?? null;
      } else if (exported.error.code !== "unreachable" || source === null) return exported;
      if (source === null) return { ok: false, error: { code: "not_found", message: "No definition is available for this routine." } };
      const target = await host.call(to, "routines.list", {});
      if (!target.ok) return target;
      const origin = source.state.movedFrom;
      const original = origin?.environmentId === to ? target.result.routines.find(r => r.state.id === origin.routineId && r.state.movedTo?.environmentId === from && r.state.movedTo.routineId === routineId) : undefined;
      // JSON is YAML 1.2: use the shared document mapping without bundling a YAML parser in clients.
      const yaml = name !== undefined ? JSON.stringify(documentOfDefinition({ ...source.definition, name })) : exported.ok ? exported.result.yaml : JSON.stringify(documentOfDefinition(source.definition));
      const checked = await host.call(to, "routines.checkImport", { yaml, ...(original && { routineId: original.state.id }) });
      if (!checked.ok) return checked;
      const targetId = original?.state.id ?? uuidv4();
      let confirmed: Promise<RoutineMoveResult> | undefined;
      const confirm = async (): Promise<RoutineMoveResult> => {
        if (checked.result.documents.length !== 1 || checked.result.documents.some(d => d.issues.length > 0)) return { ok: false, error: { code: "invalid_params", message: "Resolve the import issues before moving this routine." } };
        // Settlement follows the copy's movedFrom link, including when this move restores its original.
        if (original) host.reserve(to, targetId, from, routineId);
        else host.reserve(from, routineId, to, targetId);
        const imported = await host.dispatch(to, "routines.import", { yaml, ...(original ? { routineId: targetId } : { routineIds: [targetId], movedFrom: { environmentId: from, routineId } }) });
        if (!imported.ok) return imported;
        if (original) {
          const enabled = await host.dispatch(to, "routines.enable", { routineId: targetId });
          if (!enabled.ok) return enabled;
        }
        // The disable is retained by the outbox even while the source is down.
        void host.dispatch(from, "routines.disable", { routineId, movedTo: { environmentId: to, routineId: targetId } });
        return { ok: true, routineId: targetId };
      };
      return { ok: true, documents: checked.result.documents, confirm: () => confirmed ??= confirm() };
    },
  };
};
