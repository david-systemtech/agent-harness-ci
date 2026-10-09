import { TechnicalDetails } from "../setup/details.js";
import { useDetails } from "../setup/use-details.js";

/**
 * A refused change on the Permissions form (setup-copy.md §1 rules 7 and
 * 15): its plain line as text and colour, an alert read with a hidden
 * "Error: " first, and the environment's own words under Details.
 */
export const FieldError = ({ line, details }: { readonly line: string; readonly details: readonly string[] }) => {
  const report = useDetails();
  return (
    <div role="alert" className="flex min-w-0 flex-col gap-1">
      <p className="text-xs text-signal"><span className="sr-only">Error: </span>{line}</p>
      {details.length > 0 && <TechnicalDetails {...report({ line, details })} />}
    </div>
  );
};
