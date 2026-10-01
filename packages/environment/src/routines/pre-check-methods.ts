import { ContractError, MAX_PRE_CHECK_OUTPUT_BYTES, invalidParams, type ParamsOf } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { MethodHandlers } from "../serve/methods.js";
import type { Reader } from "../sessions/session-tables.js";
import { routineNotFound } from "./methods.js";
import { MAX_PRE_CHECK_SHOWN_OUTPUT } from "./pre-check-block.js";
import type { PreCheckRunner, PreCheckSubject } from "./pre-check.js";
import { liveRoutine, routineBaseline } from "./routine-store.js";
import type { ScriptsDirectory } from "./scripts-directory.js";

/**
 * The pre-checks' methods (routines spec, "Methods on the wire"; #526):
 * `routines.scripts.list` at `read`, the scripts directory's regular files;
 * and `routines.testPreCheck` at `runs:drive`, which runs a routine's
 * pre-check, or one not yet saved in the workspace given, once, bounded at
 * 25 seconds inside a client's request timeout, and records nothing, so a
 * person can check that a script gives the same hash twice. It answers
 * what the run found, the output's first 8,000 characters, and whether the
 * hash differs from the routine's baseline (null with none, or for a
 * pre-check not yet saved). Output past 1 MiB is answered
 * `output_too_large`, and a host on the denylist's hosts that a URL
 * pre-check names or is redirected to `denylisted`, as the method declares;
 * any other failure is the answer's.
 */

/** How long `routines.testPreCheck` lets a pre-check run: 25 seconds, inside a client's 30-second request timeout. */
export const TEST_PRE_CHECK_BOUND_MS = 25_000;

export interface PreCheckMethodsOptions {
  readonly log: EventLog;
  /** The environment's clock: the due time a tested script is told. */
  readonly clock: () => Date;
  readonly scripts: ScriptsDirectory;
  readonly preChecks: PreCheckRunner;
}

type PreCheckMethodName = "routines.scripts.list" | "routines.testPreCheck";

export const preCheckMethods = (options: PreCheckMethodsOptions): Required<Pick<MethodHandlers, PreCheckMethodName>> => {
  const reader: Reader = { all: (sql, ...params) => options.log.read(sql, ...params) };

  /** What to test: the routine's pre-check, workspace and baseline, or the pre-check and workspace given. */
  const testedOf = (params: ParamsOf<"routines.testPreCheck">) => {
    if (params.routineId === undefined) {
      if (params.preCheck === undefined || params.workspace === undefined) throw new Error("routines.testPreCheck's schema lets through neither a routine nor a pre-check with its workspace.");
      return { preCheck: params.preCheck, routine: null, workspace: params.workspace, baselineHash: null };
    }
    const id = params.routineId.toLowerCase();
    const routine = liveRoutine(reader, id);
    if (routine === null) throw new ContractError(routineNotFound(id));
    const { preCheck, name, workspace } = routine.definition;
    if (preCheck === null) {
      throw new ContractError(invalidParams([{ code: "custom", path: ["routineId"], message: `The routine ${id} has no pre-check to run.` }], "The routine has no pre-check."));
    }
    return { preCheck, routine: { id, name }, workspace, baselineHash: routineBaseline(reader, id)?.hash ?? null };
  };

  return {
    "routines.scripts.list": async () => ({ directory: options.scripts.path, scripts: await options.scripts.list() }),

    "routines.testPreCheck": async (params) => {
      const { preCheck, routine, workspace, baselineHash } = testedOf(params);
      const subject: PreCheckSubject = { routine, dueAt: options.clock().toISOString(), trigger: "test", workspace };
      const { record, deniedHost } = await options.preChecks.run(preCheck, subject, { baselineHash, boundMs: TEST_PRE_CHECK_BOUND_MS });
      if (record.failure?.reason === "output_too_large") {
        throw new ContractError({ code: "output_too_large", message: record.failure.detail, data: { limitBytes: MAX_PRE_CHECK_OUTPUT_BYTES } });
      }
      if (deniedHost !== null) throw new ContractError({ code: "denylisted", message: record.failure?.detail ?? `${deniedHost} is on the denylist's hosts.`, data: { host: deniedHost } });
      return { ...record, output: record.output === null ? null : record.output.slice(0, MAX_PRE_CHECK_SHOWN_OUTPUT) };
    },
  };
};
