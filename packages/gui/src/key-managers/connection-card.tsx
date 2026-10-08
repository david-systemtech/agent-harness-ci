import { Copy, LogIn, LogOut, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Vault } from "lucide-react";
import { ActionButton as Button } from "./action-button.js";
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
import { Fact, ToneBadge } from "../ui/index.js";
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
    <section data-access-card aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <Vault aria-hidden="true" className="size-4 text-ink-muted" />
        <h3 id={heading} className="min-w-0 break-words text-xs font-semibold text-ink">{connection.label}</h3>
        <ToneBadge tone={kind === "signed-in" ? "success" : "warning"}>
          <ShieldCheck aria-hidden="true" />{kind === "signed-in" ? "Verified" : "Not verified"}
        </ToneBadge>
      </header>
      <dl className="grid grid-cols-[minmax(0,112px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs [&_dt]:py-0 [&_dd]:py-0">
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
          <Button icon={ShieldCheck} label="Check its certificate" variant="default" disabled={!writable} onClick={() => setOpen("certificate")}>
            Check its certificate
          </Button>
        )}
        <Button icon={LogIn} label={awaiting ? "Sign in" : "Sign in again"} variant={SIGN_IN_FIXES.has(kind) ? "default" : "ghost"} disabled={!writable} onClick={() => setOpen("sign-in")}>
          {awaiting ? "Sign in" : "Sign in again"}
        </Button>
        <Button icon={RefreshCw} label="Verify now" disabled={!writable || awaiting || sending} onClick={() => send(() => verifyConnection(runtime, environmentId, connection))}>
          Verify now
        </Button>
        {!connection.injects && (
          <Button icon={Plus} label="Inject its variables" disabled={!writable || sending} onClick={() => send(() => setInjected(sender, environmentId, connection, "Inject its variables"))}>
            Inject its variables
          </Button>
        )}
        <Button icon={Pencil} label="Edit" disabled={!writable} onClick={() => setOpen("edit")}>
          Edit
        </Button>
        <Button icon={LogOut} label="Sign out" disabled={!writable || awaiting} onClick={() => setOpen("sign-out")}>
          Sign out
        </Button>
        <Button icon={Trash2} label="Remove" disabled={!writable} onClick={() => setOpen("remove")}>
          Remove
        </Button>
        <Button icon={Copy} label="Copy to other environments" onClick={() => setOpen("copy")}>Copy to other environments</Button>
      </div>
      {open === "certificate" && (
        <CertificateCheck
          environmentId={environmentId}
          address={connection.address}
          close={close}
          trust={(ca) => void updateConnection(sender, environmentId, connection, { ca }, "Trust this certificate").then((updated) => say(updated.line))}
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
