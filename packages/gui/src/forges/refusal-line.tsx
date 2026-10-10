import type { ForgeRefused } from "@agent-harness/client-runtime";
import { useWindowFrame } from "../frame/window-controls.js";
import { TechnicalDetails } from "../setup/details.js";
import { useClientVersion, useShell } from "../window-context.js";

/**
 * A forge command's refusal on the Forges card (setup-copy.md §1 rules 7 and
 * 15, §5.6): its plain line as an alert read with a hidden "Error: " first,
 * and its raw words under Details.
 */
export const RefusalLine = ({ refused, computer }: { readonly refused: Pick<ForgeRefused, "line" | "details">; readonly computer: string }) => (
  <div className="flex min-w-0 flex-col gap-1">
    <p role="alert" className="text-sm text-signal">
      <span className="sr-only">Error: </span>
      <span>{refused.line}</span>
    </p>
    <ForgeDetails line={refused.line} details={refused.details} computer={computer} />
  </div>
);

/** The raw words behind a line the card says, under Details with Copy details, naming the computer they came from; nothing for none. */
export const ForgeDetails = ({ line, details, computer }: { readonly line: string; readonly details: readonly string[]; readonly computer: string }) => {
  const shell = useShell();
  const version = useClientVersion();
  const frame = useWindowFrame();
  if (details.length === 0) return null;
  return (
    <TechnicalDetails
      report={{ app: { version, platform: frame?.platform ?? "unknown" }, computer: { name: computer }, line, details }}
      copy={(text) => (shell?.clipboard === undefined ? Promise.reject(new Error("This app has no clipboard.")) : shell.clipboard.writeText(text))}
    />
  );
};
