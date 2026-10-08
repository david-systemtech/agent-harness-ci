import { uuidv7, type CachedAnswer, type EnvironmentView } from "@agent-harness/client-runtime";
import { CATALOGUE_SEED_INSTRUCTION_ID, type OwnedInstructionRow } from "@agent-harness/contracts";
import { useEffect, useRef, useState } from "react";
import { useClock, useRuntime } from "../window-context.js";

// Instruction ids are environment-local. Every client uses this id for the automatic seed,
// so the environment's existing create conflict also guards simultaneous first opens.
const SETUP_SEED_ID = "caeaf124-d65a-4a27-91a2-196ab5870ed5";

/** The seeded note, About my setup: found by its origin, or by its title where an older seed has none. */
export const isSetupNote = (row: OwnedInstructionRow): boolean => row.origin?.catalogueId === CATALOGUE_SEED_INSTRUCTION_ID || row.title === "About my setup";

export const SetupSeed = ({ view, listed }: { readonly view: EnvironmentView; readonly listed: CachedAnswer<"instructions.list"> }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const attempted = useRef(false);
  const [line, say] = useState<string | undefined>(undefined);
  const mayCreate = runtime.capability(view.environmentId, "instructions.create").status === "present";
  useEffect(() => {
    const result = listed.result;
    if (attempted.current || view.phase !== "ready" || !mayCreate || listed.loading || listed.error !== null || result === null) return;
    if (
      result.dismissed.includes(CATALOGUE_SEED_INSTRUCTION_ID) ||
      result.instructions.some(isSetupNote)
    ) return;
    attempted.current = true;
    void runtime.requests.call(view.environmentId, "instructions.create", { commandId: uuidv7(clock.now()), id: SETUP_SEED_ID, catalogueId: CATALOGUE_SEED_INSTRUCTION_ID }).then((answer) => {
      const error = !answer.ok ? answer.error : answer.result.receipt.status === "rejected" ? answer.result.receipt.error : undefined;
      if (error !== undefined && !(error.code === "conflict" && error.data?.["reason"] === "exists")) say(`About my setup was not created: ${error.message}`);
      runtime.requests.refresh(view.environmentId, "instructions.list", {});
    });
  }, [runtime, clock, view.environmentId, view.phase, mayCreate, listed]);
  return line === undefined ? null : (
    <p role="status" className="text-sm text-signal">
      {line}
    </p>
  );
};
