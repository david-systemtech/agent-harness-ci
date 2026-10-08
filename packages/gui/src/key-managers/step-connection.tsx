import { LogIn, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import { ActionButton as Button } from "./action-button.js";
import { CONNECTION_FIX_WORDS, connectionHealth, updateConnection, verifyConnection, type ConnectionFix, type EnvironmentView } from "@agent-harness/client-runtime";
import type { ListedKeyManagerConnection } from "@agent-harness/contracts";
import { useId, useState } from "react";
import type { DrawnToolTerminal } from "../managed-tools/tool-terminal.js";
import { ToolRow } from "../managed-tools/tool-row.js";
import { MoreOptions } from "../setup/more-options.js";
import { useClock, useRuntime } from "../window-context.js";
import { CertificateCheck } from "./certificate-check.js";
import { SignInAgain } from "./connection-dialogs.js";
import { ConnectionSwitch } from "./injection-setting.js";
import { PolicyTicks } from "./policy-ticks.js";
import { RefusalLine } from "./refusal-line.js";

/** Each fix's button icon. */
const FIX_ICONS: Readonly<Record<ConnectionFix, LucideIcon>> = { "sign-in": LogIn, "sign-in-again": LogIn, "check-again": RefreshCw, "check-certificate": ShieldCheck };

/** What a connection's verb last said: a line, or a refusal with its Details. */
type Said = { readonly ok: true; readonly line: string } | { readonly ok: false; readonly line: string; readonly details?: readonly string[] | undefined };

/**
 * A connection on the Key manager card (setup-copy.md §5.7; #590, #1851):
 * its label and address; its health in one line, `{state} since {time}.
 * {what to do}`, with the one button that does it (Sign in, Sign in again,
 * Check again, or Check certificate), the environment's own words for the
 * status being the step's Details; and its switch, which shows what
 * Settings › Key managers shows (`ConnectionSwitch`).
 */
export const StepConnection = ({ view, connection, writable }: { readonly view: EnvironmentView; readonly connection: ListedKeyManagerConnection; readonly writable: boolean }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const { environmentId } = view;
  const [open, setOpen] = useState<"sign-in" | "certificate" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [said, setSaid] = useState<Said | undefined>(undefined);
  const { line, fix } = connectionHealth(connection.status, clock.now());
  const close = () => setOpen(null);
  const act = (chosen: ConnectionFix) => {
    setSaid(undefined);
    if (chosen === "sign-in" || chosen === "sign-in-again") return setOpen("sign-in");
    if (chosen === "check-certificate") return setOpen("certificate");
    setVerifying(true);
    void verifyConnection(runtime, environmentId, connection, CONNECTION_FIX_WORDS[chosen]).then((verified) => {
      setVerifying(false);
      // A verification that answered shows in the health line; only a refusal is said.
      if (!verified.ok) setSaid(verified);
    });
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-lg border border-hairline bg-panel p-3">
      <h4 id={heading} className="text-sm font-semibold text-ink">
        {connection.label}
      </h4>
      <p className="text-xs break-all text-ink-muted">{connection.address}</p>
      <p data-connection-health={connection.status.kind} className={fix === null ? "text-sm text-ink" : "text-sm text-amber"}>{line}</p>
      {fix !== null && (
        <Button icon={FIX_ICONS[fix]} label={CONNECTION_FIX_WORDS[fix]} variant="default" className="self-start" disabled={!writable || verifying} onClick={() => act(fix)}>
          {CONNECTION_FIX_WORDS[fix]}
        </Button>
      )}
      <ConnectionSwitch view={view} connection={connection} writable={writable} />
      {said !== undefined && (said.ok ? <p role="status" className="text-sm text-ink">{said.line}</p> : <RefusalLine line={said.line} details={said.details} />)}
      {open === "sign-in" && (
        <SignInAgain environmentId={environmentId} connection={connection} close={close} say={(signed) => setSaid({ ok: true, line: signed })} again={connection.status.kind !== "awaiting-sign-in"} />
      )}
      {open === "certificate" && (
        <CertificateCheck
          environmentId={environmentId}
          address={connection.address}
          close={close}
          trust={(ca) => void updateConnection({ runtime, clock }, environmentId, connection, { ca }, "Trust this certificate").then((updated) => setSaid(updated.ok ? { ok: true, line: updated.line } : updated))}
        />
      )}
    </section>
  );
};

/** What a connection's CLI row may do on the card: send Install, Update and Verify, ask claude's detail, and draw the tool terminal a run opens. */
export interface ConnectionTools {
  readonly writable: boolean;
  readonly readable: boolean;
  readonly terminal: DrawnToolTerminal;
}

/**
 * The card's one More options for its connections (setup-copy.md §1 rule 5;
 * #590, #1851): under each connection's label, the login's policy ticks
 * with the write warning (`PolicyTicks`) and its CLI's Managed tools row
 * (`ToolRow`, #426), whose Install or Update runs `tools.run` in a tool
 * terminal the card draws. A CLI that is missing or below its minimum is the
 * step's own line, with its Install or Update, so it is not said again here.
 */
export const ConnectionsMoreOptions = ({
  environmentId,
  environmentName,
  connections,
  writable,
  tools,
}: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly connections: readonly ListedKeyManagerConnection[];
  readonly writable: boolean;
  readonly tools: ConnectionTools;
}) => (
  <section aria-label="More options for your key managers">
    <MoreOptions step="key-manager">
      {connections.map((connection) => (
        <ConnectionOptions key={connection.id} environmentId={environmentId} environmentName={environmentName} connection={connection} writable={writable} tools={tools} />
      ))}
    </MoreOptions>
  </section>
);

const ConnectionOptions = ({
  environmentId,
  environmentName,
  connection,
  writable,
  tools,
}: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly connection: ListedKeyManagerConnection;
  readonly writable: boolean;
  readonly tools: ConnectionTools;
}) => {
  const heading = useId();
  const [line, say] = useState<string | undefined>(undefined);
  const { cli } = connection;
  return (
    <div role="group" aria-labelledby={heading} className="flex flex-col gap-2 border-t border-hairline pt-3 first:border-t-0 first:pt-0">
      <h4 id={heading} className="text-sm font-semibold text-ink">
        {connection.label}
      </h4>
      <PolicyTicks environmentId={environmentId} connection={connection} writable={writable} say={say} />
      {line !== undefined && <p role="status" className="text-sm text-ink-muted">{line}</p>}
      <ToolRow
        environmentId={environmentId}
        name={environmentName}
        row={cli}
        writable={tools.writable}
        readable={tools.readable}
        finished={tools.terminal.finishedOf(cli.tool)}
        started={tools.terminal.started}
      />
    </div>
  );
};
