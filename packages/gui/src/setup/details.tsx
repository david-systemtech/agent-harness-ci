import { Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Fold } from "../ui/index.js";
import { STATE_WORDS, type SetupState } from "./health-dot.js";

/** What Copy details says about a problem (setup-copy.md §3); what is not known is left out. */
export interface DetailsReport {
  /** This app's version and the platform it runs on. */
  readonly app: { readonly version: string; readonly platform: string };
  /** The computer the problem is on, with the agent-harness version it runs when known. */
  readonly computer?: { readonly name: string; readonly version?: string };
  readonly step?: { readonly label: string; readonly id: string; readonly state: SetupState };
  /** When it was checked, as the result's ISO time. */
  readonly checkedAt?: string;
  /** The plain line the person read. */
  readonly line: string;
  /** The ids of the checks that did not pass. */
  readonly failing?: readonly string[];
  /** The technical facts, one line each (a result's `details`, a start's failure text). */
  readonly details?: readonly string[];
}

/** The lines Details shows and Copy details copies, one per line. */
export const detailsText = ({ app, computer, step, checkedAt, line, failing = [], details = [] }: DetailsReport): readonly string[] => [
  `agent-harness ${app.version} on ${app.platform}`,
  ...(computer === undefined ? [] : [`Computer: ${computer.name}${computer.version === undefined ? "" : ` (agent-harness ${computer.version})`}`]),
  ...(step === undefined ? [] : [`Step: ${step.label} (${step.id}): ${STATE_WORDS[step.state]}`]),
  ...(checkedAt === undefined ? [] : [`Checked: ${checkedAt}`]),
  `What we saw: ${line}`,
  ...(failing.length === 0 ? [] : [`Checks: ${failing.join(", ")}`]),
  ...(details.length === 0 ? [] : ["Details:", ...details]),
];

export interface TechnicalDetailsProps {
  readonly report: DetailsReport;
  /** Writes to the clipboard of the caller's platform; a rejection is a refused copy. */
  copy(text: string): Promise<void>;
  /** Open from the start (the gallery's open state); otherwise it opens when chosen. */
  readonly defaultOpen?: boolean;
}

/**
 * Details (setup-copy.md §1 rule 7, §3): a fold holding the technical lines in
 * mono and Copy details, which copies the same lines, so a refused copy leaves
 * the person the text to select.
 */
export const TechnicalDetails = ({ report, copy, defaultOpen = false }: TechnicalDetailsProps) => {
  const [open, setOpen] = useState(defaultOpen);
  const [status, setStatus] = useState<"ready" | "copied" | "refused">("ready");
  const [copies, setCopies] = useState(0);
  const request = useRef(0);
  const text = detailsText(report).join("\n");
  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setStatus("ready"), 1500);
    return () => clearTimeout(timer);
  }, [status, copies]);
  useEffect(() => () => { request.current += 1; }, []);
  const run = async () => {
    const current = ++request.current;
    try { await copy(text); if (current === request.current) { setStatus("copied"); setCopies((count) => count + 1); } }
    catch { if (current === request.current) setStatus("refused"); }
  };
  return (
    <Fold summary="Details" open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 flex-col items-start gap-1.5">
        <pre className="w-full min-w-0 bg-inset p-2 font-mono text-xs break-all whitespace-pre-wrap text-ink select-text">{text}</pre>
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <Button variant="outline" size="xs" onClick={() => { void run(); }}><Copy aria-hidden="true" />Copy details</Button>
          <span role="status" className={status === "refused" ? "text-xs text-signal" : "text-xs text-ink-muted"}>
            {status === "copied" ? "Copied." : status === "refused" ? "Could not copy. Select the text instead." : ""}
          </span>
        </span>
      </div>
    </Fold>
  );
};
