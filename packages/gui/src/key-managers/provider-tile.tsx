import { LogIn } from "lucide-react";
import { ActionButton as Button } from "./action-button.js";
import { KEY_MANAGER_PROVIDER_WORDS, KEY_MANAGER_STATUS_ADVICE, cliHealthWords, statusWords, updateConnection, verifyConnection } from "@agent-harness/client-runtime";
import type { KeyManagerProvider, KeyManagerStatusKind, ListedKeyManagerConnection } from "@agent-harness/contracts";
import { useId, useState } from "react";
import type { DrawnToolTerminal } from "../managed-tools/tool-terminal.js";
import { ToolRow } from "../managed-tools/tool-row.js";
import { useClock, useRuntime } from "../window-context.js";
import { SignInForm } from "./add-connection.js";
import { CertificateCheck } from "./certificate-check.js";
import { SignInAgain } from "./connection-dialogs.js";
import { PolicyTicks } from "./policy-ticks.js";

/** What a connection's CLI row may do on the card: send Install, Update and Verify, ask claude's detail, and draw the tool terminal a run opens. */
export interface TileTools {
  readonly writable: boolean;
  readonly readable: boolean;
  readonly terminal: DrawnToolTerminal;
}

export interface ProviderTileProps {
  readonly environmentId: string;
  /** The environment's name, for the lines said. */
  readonly environmentName: string;
  readonly provider: KeyManagerProvider;
  /** The provider's connections, as the cached `keyManagers.list` holds them. */
  readonly connections: readonly ListedKeyManagerConnection[];
  /** Whether this client may sign in and change them: the environment reached, with `admin`. */
  readonly writable: boolean;
  readonly tools: TileTools;
}

/**
 * A provider's tile on the Key manager card (the Set up specification, "5.
 * Key manager"; ADR 0028; #590): the provider's name, each of its
 * connections signed in, and its sign-in form (`SignInForm`, the Key
 * managers row's Add for this provider alone), opened by Sign in, or Sign
 * in to another once one is connected. What a sign-in or a verb did is one
 * line under it.
 */
export const ProviderTile = ({ environmentId, environmentName, provider, connections, writable, tools }: ProviderTileProps) => {
  const heading = useId();
  const [signingIn, setSigningIn] = useState(false);
  const [line, say] = useState<string | undefined>(undefined);
  const name = KEY_MANAGER_PROVIDER_WORDS[provider];
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <h3 id={heading} className="text-xs font-semibold text-ink">
        {name}
      </h3>
      {connections.map((connection) => (
        <TileConnection key={connection.id} environmentId={environmentId} environmentName={environmentName} connection={connection} writable={writable} tools={tools} say={say} />
      ))}
      {signingIn ? (
        <SignInForm environmentId={environmentId} providers={[provider]} name={`Sign in to ${name}`} send="Sign in" close={() => setSigningIn(false)} say={say} />
      ) : (
        <Button icon={LogIn} label={connections.length === 0 ? "Sign in" : "Sign in to another"} variant="outline" className="self-start" disabled={!writable} onClick={() => setSigningIn(true)}>
          {connections.length === 0 ? "Sign in" : "Sign in to another"}
        </Button>
      )}
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
    </section>
  );
};

/** The verb a status's health line offers: a sign-in, a sign-in again, a verification once the key manager answers, or a look at the certificate it presents. */
type Fix = "sign-in" | "sign-in-again" | "verify" | "certificate";

const FIXES: Readonly<Record<KeyManagerStatusKind, Fix | null>> = {
  "provider-unavailable": "verify",
  "awaiting-sign-in": "sign-in",
  "signing-in": null,
  "signed-in": null,
  "credential-rejected": "sign-in-again",
  expired: "sign-in-again",
  unreachable: "verify",
  sealed: "verify",
  "certificate-rejected": "certificate",
};

const FIX_WORDS: Readonly<Record<Fix, string>> = { "sign-in": "Sign in", "sign-in-again": "Sign in again", verify: "Verify now", certificate: "Check its certificate" };

interface TileConnectionProps extends Omit<ProviderTileProps, "provider" | "connections"> {
  readonly connection: ListedKeyManagerConnection;
  readonly say: (line: string) => void;
}

/**
 * A connection on its provider's tile (#590): its label and address; its
 * health line, the status with its since-time, the environment's line and
 * what it asks in the client runtime's words, so sealed, expired and
 * unreachable each show their own fix, with that fix's verb; the login's
 * policy ticks with the write warning (`PolicyTicks`); and its CLI's
 * Managed tools row (`ToolRow`, #426), under the line saying a CLI runs need
 * is missing or below its minimum, whose Install or Update runs `tools.run`
 * in a tool terminal the card draws.
 */
const TileConnection = ({ environmentId, environmentName, connection, writable, tools, say }: TileConnectionProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const [open, setOpen] = useState<"sign-in" | "certificate" | null>(null);
  const [verifying, setVerifying] = useState(false);
  const { status, cli } = connection;
  const fix = FIXES[status.kind];
  const advice = KEY_MANAGER_STATUS_ADVICE[status.kind];
  const cliHealth = cliHealthWords(connection);
  const close = () => setOpen(null);
  const act = (chosen: Fix) => {
    if (chosen !== "verify") return setOpen(chosen === "certificate" ? "certificate" : "sign-in");
    setVerifying(true);
    void verifyConnection(runtime, environmentId, connection).then((verified) => {
      setVerifying(false);
      say(verified.line);
    });
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 border-t border-hairline pt-3">
      <h4 id={heading} className="text-sm font-semibold text-ink">
        {connection.label}
      </h4>
      <p className="text-xs text-ink-muted">{connection.address}</p>
      <p className="text-sm text-ink">
        {statusWords(status, clock.now())}. {status.message}
        {advice !== null && <span className="text-ink-muted"> {advice}</span>}
      </p>
      {fix !== null && (
        <Button icon={LogIn} label={FIX_WORDS[fix]} variant="default" className="self-start" disabled={!writable || verifying} onClick={() => act(fix)}>
          {FIX_WORDS[fix]}
        </Button>
      )}
      <PolicyTicks environmentId={environmentId} connection={connection} writable={writable} say={say} />
      {cliHealth !== null && <p className="text-sm text-amber">{cliHealth}</p>}
      <ToolRow
        environmentId={environmentId}
        name={environmentName}
        row={cli}
        writable={tools.writable}
        readable={tools.readable}
        finished={tools.terminal.finishedOf(cli.tool)}
        started={tools.terminal.started}
      />
      {open === "sign-in" && <SignInAgain environmentId={environmentId} connection={connection} close={close} say={say} again={status.kind !== "awaiting-sign-in"} />}
      {open === "certificate" && (
        <CertificateCheck
          environmentId={environmentId}
          address={connection.address}
          close={close}
          trust={(ca) => void updateConnection({ runtime, clock }, environmentId, connection, { ca }).then((updated) => say(updated.line))}
        />
      )}
    </section>
  );
};
