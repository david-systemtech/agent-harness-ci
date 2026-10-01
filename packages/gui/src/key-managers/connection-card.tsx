import {
  KEY_MANAGER_PROVIDER_WORDS,
  KEY_MANAGER_STATUS_ADVICE,
  basePathWords,
  caWords,
  cliWords,
  injectsWords,
  methodWords,
  mintWords,
  originWords,
  statusWords,
  setInjected,
  tokenWords,
  updateConnection,
  verifyConnection,
} from "@agent-harness/client-runtime";
import type { KeyManagerStatusKind, ListedKeyManagerConnection } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { Button, Fact } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { CertificateCheck } from "./certificate-check.js";
import { ConfirmRemove, ConfirmSignOut, EditConnection, SignInAgain } from "./connection-dialogs.js";
import { CopyConnection } from "./copy-connection.js";
import { PolicyTicks } from "./policy-ticks.js";

/** The dialog a card has open: none, or one of its verbs'. */
type Open = "certificate" | "sign-in" | "edit" | "sign-out" | "remove" | "copy" | null;

/** The statuses a sign-in answers: no credential here, or one the key manager no longer takes. */
const SIGN_IN_FIXES: ReadonlySet<KeyManagerStatusKind> = new Set<KeyManagerStatusKind>(["awaiting-sign-in", "credential-rejected", "expired"]);

export interface ConnectionCardProps {
  readonly environmentId: string;
  /** The connection as the cached `keyManagers.list` holds it, with its CLI's Managed tools row (#375). */
  readonly connection: ListedKeyManagerConnection;
  /** Whether this client may change it: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Says one line in the pane: what a command did, or why it did not. */
  readonly say: (line: string) => void;
}

/**
 * A key-manager connection's card (key-managers spec, "The connection
 * record"; ADR 0028; #425), drawn from `keyManagers.list`'s record as the
 * request cache holds it: its provider, label and address; how it signs in;
 * its status with its since-time, the environment's line and what that
 * status asks; its token information; whether it can mint run tokens; its
 * base path, or the one suggested; whether runs receive its variables; its
 * CLI's Managed tools row, the one the listed connection carries (#776);
 * and where it was copied from.
 */
export const ConnectionCard = ({ environmentId, connection, writable, say }: ConnectionCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const now = clock.now();
  const [open, setOpen] = useState<Open>(null);
  const [sending, setSending] = useState(false);
  /** Sends a verb answered in one line, taking no second press while it is on its way. */
  const send = (verb: () => Promise<{ readonly line: string }>) => {
    setSending(true);
    void verb().then((done) => {
      setSending(false);
      say(done.line);
    });
  };
  const sender = { runtime, clock };
  const kind = connection.status.kind;
  const awaiting = kind === "awaiting-sign-in";
  const close = () => setOpen(null);
  const dialog = { environmentId, connection, close, say };
  const advice = KEY_MANAGER_STATUS_ADVICE[kind];
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
        {connection.label}
      </h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <Fact name="Provider">{KEY_MANAGER_PROVIDER_WORDS[connection.provider]}</Fact>
        <Fact name="Address">{connection.address}</Fact>
        <Fact name="Signs in by">{methodWords(connection)}</Fact>
        <Fact name="CA">{caWords(connection)}</Fact>
        <Fact name="Status">{statusWords(connection.status, now)}</Fact>
        <Fact name="Token">{tokenWords(connection.tokenInformation, now)}</Fact>
        <Fact name="Run tokens">{mintWords(connection.canMint)}</Fact>
        <Fact name="Base path">{basePathWords(connection)}</Fact>
        <Fact name="Runs">{injectsWords(connection)}</Fact>
        <Fact name="CLI">{cliWords(connection.cli)}</Fact>
        <Fact name="Copied from">{originWords(connection)}</Fact>
      </dl>
      <PolicyTicks environmentId={environmentId} connection={connection} writable={writable} say={say} />
      <p className="text-sm text-ink">
        {connection.status.message}
        {advice !== null && <span className="text-ink-muted"> {advice}</span>}
      </p>
      <div className="flex flex-wrap gap-2">
        {kind === "certificate-rejected" && (
          <Button tone="primary" disabled={!writable} onClick={() => setOpen("certificate")}>
            Check its certificate
          </Button>
        )}
        <Button tone={SIGN_IN_FIXES.has(kind) ? "primary" : "quiet"} disabled={!writable} onClick={() => setOpen("sign-in")}>
          {awaiting ? "Sign in" : "Sign in again"}
        </Button>
        <Button disabled={!writable || awaiting || sending} onClick={() => send(() => verifyConnection(runtime, environmentId, connection))}>
          Verify now
        </Button>
        {!connection.injects && (
          <Button disabled={!writable || sending} onClick={() => send(() => setInjected(sender, environmentId, connection))}>
            Inject its variables
          </Button>
        )}
        <Button disabled={!writable} onClick={() => setOpen("edit")}>
          Edit
        </Button>
        <Button disabled={!writable || awaiting} onClick={() => setOpen("sign-out")}>
          Sign out
        </Button>
        <Button disabled={!writable} onClick={() => setOpen("remove")}>
          Remove
        </Button>
        <Button onClick={() => setOpen("copy")}>Copy to other environments</Button>
      </div>
      {open === "certificate" && (
        <CertificateCheck
          environmentId={environmentId}
          address={connection.address}
          close={close}
          trust={(ca) => void updateConnection(sender, environmentId, connection, { ca }).then((updated) => say(updated.line))}
        />
      )}
      {open === "sign-in" && <SignInAgain {...dialog} again={!awaiting} />}
      {open === "edit" && <EditConnection {...dialog} />}
      {open === "sign-out" && <ConfirmSignOut {...dialog} />}
      {open === "remove" && <ConfirmRemove {...dialog} />}
      {open === "copy" && <CopyConnection environmentId={environmentId} connection={connection} close={close} />}
    </section>
  );
};
