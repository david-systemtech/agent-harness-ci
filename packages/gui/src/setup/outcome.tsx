import type { ActionOutcome } from "@agent-harness/client-runtime";
import { CopyLine } from "../settings/copy-line.js";
import { classes } from "../ui/classes.js";

/**
 * What an action did, as the window says it (setup-copy.md §1 rules 7 and
 * 15): its line in the main text, a status when it went ahead, an alert in
 * the error colour read with a hidden "Error: " first when it was refused;
 * its raw words (codes, messages, program output) beneath under Details,
 * one per line, with Copy details.
 */
export const Outcome = ({ outcome: { ok, line, details = [] }, className }: { readonly outcome: Pick<ActionOutcome, "ok" | "line" | "details">; readonly className?: string }) => (
  <>
    <p role={ok ? "status" : "alert"} className={classes(className, !ok && "text-signal")}>{!ok && <><span className="sr-only">Error:</span>{" "}</>}{line}</p>
    {details.length > 0 && <CopyLine label="Details" text={details.join("\n")} copyLabel="Copy details" />}
  </>
);
