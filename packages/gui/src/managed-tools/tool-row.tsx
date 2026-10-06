import {
  INSTALL_METHOD_WORDS,
  MANAGED_TOOL_STATUS_WORDS,
  doctorMethodWords,
  noCommandWords,
  requiredWords,
  runTool,
  runWords,
  toolRunWords,
  verifyTool,
  type ActionOutcome,
} from "@agent-harness/client-runtime";
import { VerifiableToolName, managedTool, type ManagedToolDetail, type ManagedToolRow, type RunnableToolAction, type ToolRunFinishedPayload } from "@agent-harness/contracts";
import { ArrowDownToLine, CircleCheck, Info, Terminal } from "lucide-react";
import { useId, useState } from "react";
import { CopyLine } from "../settings/copy-line.js";
import { Button, Fact, Tooltip } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import type { ShownRun } from "./tool-terminal.js";

export interface ToolRowProps {
  readonly environmentId: string;
  /** The environment's name, for the lines said. */
  readonly name: string;
  readonly row: ManagedToolRow;
  /** Whether Install, Update and Verify may be sent: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Whether claude's detail may be asked for: the environment reached. */
  readonly readable: boolean;
  /** The tool's last run heard to finish, from the environment's stream. */
  readonly finished: ToolRunFinishedPayload | undefined;
  /** Install or Update opened a tool terminal: the section draws it. */
  readonly started: (run: ShownRun) => void;
}

/**
 * One tool's row in About's Managed tools (key-managers spec, "Managed
 * tools"; ADR 0026; #426): what the environment's last probe found, its
 * version against its minimum and the latest known, its install method,
 * its status and when it is required, then its one action: Install or
 * Update, which runs `tools.run` and hands the tool terminal it opened to
 * the section, or for a Copy row the vendor's command to copy. Verify runs
 * the tool's verify command, and claude's Details its doctor beside the
 * method the harness detected. What a verb did, or why it did not, is one
 * line; how the tool's last run ended, and what the verification after it
 * found, another.
 */
export const ToolRow = ({ environmentId, name, row, writable, readable, finished, started }: ToolRowProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const [said, say] = useState<ActionOutcome | undefined>(undefined);
  /** The vendor's command a refused run answered, to copy. */
  const [refusedCommand, setRefusedCommand] = useState<string | null>(null);
  const [detail, setDetail] = useState<ManagedToolDetail | string | undefined>(undefined);
  const verifiable = VerifiableToolName.safeParse(row.tool);
  const installed = row.status !== "not-installed";
  /** What the row's one action runs; null for a Copy row, which runs nothing. */
  const action: RunnableToolAction | null = row.action === "copy" ? null : row.action;

  const run = async (action: RunnableToolAction) => {
    say(undefined);
    setRefusedCommand(null);
    const outcome = await runTool(runtime, environmentId, row.tool, action, clock.now());
    if (outcome.ok) {
      const { terminal, tool, command } = outcome.run;
      return started({ terminal: { id: terminal.id, cols: terminal.cols, rows: terminal.rows }, tool, action, command });
    }
    say({ ok: false, line: outcome.line });
    setRefusedCommand(outcome.command);
  };
  const verify = async (tool: VerifiableToolName) => {
    say(undefined);
    say(await verifyTool(runtime, environmentId, tool));
  };
  const details = async () => {
    const answer = await runtime.requests.call(environmentId, "tools.detail", { tool: "claude" });
    setDetail(answer.ok ? answer.result : `claude doctor was not asked: ${answer.error.message}`);
  };

  return (
    <section data-managed-tool={row.tool} aria-labelledby={heading} className="flex flex-col gap-2 px-3 py-2.5">
      <header className="flex flex-wrap items-center gap-2">
        <Terminal aria-hidden="true" className="size-4 text-cyan" />
        <h4 id={heading} className="text-xs font-medium text-ink">
          {row.label}
        </h4>
        <span className="font-mono text-xs text-ink-muted">{row.tool}</span>
      </header>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-2xs">
        <Fact name="Version">{installed ? (row.version ?? "Not read") : null}</Fact>
        <Fact name="Install method">{row.method === null ? null : INSTALL_METHOD_WORDS[row.method]}</Fact>
        <Fact name="Minimum">{row.minimum ?? "None"}</Fact>
        <Fact name="Latest">{installed ? (row.latest ?? "Not known yet") : null}</Fact>
        <Fact name="Status">{MANAGED_TOOL_STATUS_WORDS[row.status]}</Fact>
        <Fact name="Required">{requiredWords(managedTool(row.tool))}</Fact>
      </dl>
      <div className="flex flex-wrap gap-2">
        {action !== null && (
          <Tooltip content={runWords(row, action)} keys="Enter / Space"><Button variant="secondary" disabled={!writable} onClick={() => void run(action)}>
            <ArrowDownToLine aria-hidden="true" />{runWords(row, action)}
          </Button></Tooltip>
        )}
        {verifiable.success && (
          <Tooltip content="Verify tool" keys="Enter / Space"><Button disabled={!writable} onClick={() => void verify(verifiable.data)}>
            <CircleCheck aria-hidden="true" />Verify
          </Button></Tooltip>
        )}
        {row.tool === "claude" && (
          <Tooltip content="Tool details" keys="Enter / Space"><Button disabled={!readable} onClick={() => void details()}>
            <Info aria-hidden="true" />Details
          </Button></Tooltip>
        )}
      </div>
      {row.action === "copy" &&
        (row.command === null ? (
          <p className="text-sm text-ink-muted">{noCommandWords(row)}</p>
        ) : (
          <CopyLine label={`The vendor's command, to run yourself on ${name}`} text={row.command} />
        ))}
      {finished !== undefined && <p className="text-sm text-ink-muted">{toolRunWords(finished)}</p>}
      {said !== undefined && (
        <p role="status" className={said.ok ? "text-sm text-ink-muted" : "text-sm text-signal"}>
          {said.line}
        </p>
      )}
      {refusedCommand !== null && <CopyLine label={`The vendor's command, to run yourself on ${name}`} text={refusedCommand} />}
      {detail !== undefined && <DoctorDetail detail={detail} />}
    </section>
  );
};

/** claude's detail: the install method the harness detected beside the one `claude doctor` reports, and what doctor warns of. */
const DoctorDetail = ({ detail }: { readonly detail: ManagedToolDetail | string }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1">
      <h5 id={heading} className="text-xs text-ink-muted">
        What claude doctor says
      </h5>
      {typeof detail === "string" ? (
        <p className="text-sm text-signal">{detail}</p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-2xs">
            <Fact name="Detected install method">{detail.row.method === null ? "None: it is not installed." : INSTALL_METHOD_WORDS[detail.row.method]}</Fact>
            <Fact name="claude doctor reports">{doctorMethodWords(detail.doctor)}</Fact>
          </dl>
          {detail.doctor.outcome === "read" && detail.doctor.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-sm text-ink">
              {detail.doctor.warnings.map((warning) => (
                <li key={warning.issue}>
                  {warning.issue}
                  {warning.fix !== null && <span className="text-ink-muted"> Fix: {warning.fix}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
};
