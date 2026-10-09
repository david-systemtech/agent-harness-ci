import { CopyLine } from "../settings/copy-line.js";

/**
 * A refusal on the Key manager card or in a key-manager form (setup-copy.md
 * §1 rules 7 and 15, §5.7): its plain line as an alert, coloured and read
 * with a hidden "Error: " first, and its raw words under Details, one per
 * line, with Copy details.
 */
export const RefusalLine = ({ line, details = [] }: { readonly line: string; readonly details?: readonly string[] | undefined }) => (
  <>
    <p role="alert" className="text-sm text-signal">
      <span className="sr-only">Error: </span>
      {line}
    </p>
    {details.length > 0 && <CopyLine label="Details" text={details.join("\n")} copyLabel="Copy details" />}
  </>
);
