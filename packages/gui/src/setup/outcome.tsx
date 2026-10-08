import type { ActionOutcome } from "@agent-harness/client-runtime";
import type { ComponentProps } from "react";
import { CopyLine } from "../settings/copy-line.js";

/**
 * What an action did, as the window says it (setup-copy.md, rule 7): its
 * line in the main text, and its raw words (codes, messages, program output)
 * beneath under Details, one per line, with Copy details.
 */
export const Outcome = ({ outcome: { line, details = [] }, ...props }: { readonly outcome: Pick<ActionOutcome, "line" | "details"> } & ComponentProps<"p">) => (
  <>
    <p {...props}>{line}</p>
    {details.length > 0 && <CopyLine label="Details" text={details.join("\n")} copyLabel="Copy details" />}
  </>
);
