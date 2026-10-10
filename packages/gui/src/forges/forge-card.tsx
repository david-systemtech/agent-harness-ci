import { CapabilityDots } from "./capability-dots.js";
import { Copy, GitPullRequest, RefreshCw, ShieldCheck, Star, Trash2, X } from "lucide-react";
import { ActionButton as Button } from "../key-managers/action-button.js";
import {
  FORGE_KIND_WORDS,
  capabilitiesWords,
  credentialWords,
  forgeCopyLine,
  forgeIdentityWords,
  forgeOriginWords,
  forgeStatusWords,
  primaryWords,
  removeForge,
  setPrimaryForge,
  verifyForge,
  type ForgeOutcome,
} from "@agent-harness/client-runtime";
import type { ForgeAccountRecord } from "@agent-harness/contracts";
import { useId, useState } from "react";
import { CopyDialog } from "../settings/copy-dialog.js";
import { Dialog, DialogClose, DialogContent, Fact, ToneBadge } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";
import { KeepInKeyManager } from "./keep-in-key-manager.js";

export interface ForgeCardProps {
  readonly environmentId: string;
  readonly account: ForgeAccountRecord;
  /** Whether this client may change it: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Says one line in the pane: what a command did, or why it did not. */
  readonly say: (line: string) => void;
}

/**
 * A forge account's card (forge spec, "The forge account record"; ADR 0020,
 * ADR 0032; #419), drawn from `forge.accounts.list`'s record as the request
 * cache holds it: its origin, kind, who it answers as, where its credential
 * comes from, its status with when it last changed and the environment's
 * line, what it can do, whether it is primary and where it was copied from;
 * then Make main, Verify now, Remove (confirmed) and Copy to other
 * environments; and on a stored token, while a key manager is connected,
 * Keep this token in your key manager, which opens the Key manager step's
 * Move stored tokens (#590, #1849).
 */
export const ForgeCard = ({ environmentId, account, writable, say }: ForgeCardProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const [open, setOpen] = useState<"remove" | "copy" | null>(null);
  const { sending, send } = useForgeVerb(say);
  const sender = { runtime, clock };
  const close = () => setOpen(null);
  return (
    <section data-access-card aria-labelledby={heading} className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2">
        <GitPullRequest aria-hidden="true" className="size-4 text-ink-muted" />
        <h3 id={heading} className="min-w-0 break-all text-xs font-semibold text-ink">{account.origin}</h3>
        <ToneBadge tone={account.problem === null && account.capabilities.readRepository.state === "verified" ? "success" : "warning"}>
          <ShieldCheck aria-hidden="true" />{account.problem === null && account.capabilities.readRepository.state === "verified" ? "Verified" : "Not verified"}
        </ToneBadge>
        {account.primary && <span className="inline-flex items-center gap-1 text-xs text-amber"><Star aria-hidden="true" className="size-3" />Main forge</span>}
      </header>
      <dl className="grid grid-cols-[minmax(0,112px)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <Fact name="Kind">{FORGE_KIND_WORDS[account.kind]}</Fact>
        <Fact name="Signed in as">{forgeIdentityWords(account.identity)}</Fact>
        <Fact name="Credential">{credentialWords(account.credential)}</Fact>
        <Fact name="Status">{forgeStatusWords(account, clock.now())}</Fact>
        <Fact name="Capabilities">{capabilitiesWords(account.capabilities)}</Fact>
        <Fact name="Primary">{primaryWords(account.primary)}</Fact>
        <Fact name="Copied from">{forgeOriginWords(account)}</Fact>
      </dl>
      <CapabilityDots capabilities={account.capabilities} />
      {account.problem !== null && <p className="text-sm text-amber">{account.problem.message}</p>}
      <div className="flex flex-wrap gap-2">
        {!account.primary && (
          <Button icon={Star} label="Make main" disabled={!writable || sending} onClick={() => send(() => setPrimaryForge(sender, environmentId, account))}>
            Make main
          </Button>
        )}
        <Button icon={RefreshCw} label="Verify now" disabled={!writable || sending} onClick={() => send(() => verifyForge(runtime, environmentId, account))}>
          Verify now
        </Button>
        <Button icon={Trash2} label="Remove" disabled={!writable} onClick={() => setOpen("remove")}>
          Remove
        </Button>
        <Button icon={Copy} label="Copy to other environments" onClick={() => setOpen("copy")}>Copy to other environments</Button>
        {account.credential.kind === "stored" && <KeepInKeyManager environmentId={environmentId} />}
      </div>
      {open === "remove" && <ConfirmRemove environmentId={environmentId} account={account} close={close} say={say} />}
      {open === "copy" && (
        <CopyDialog
          environmentId={environmentId}
          title={`Copy ${account.origin} to other environments`}
          description="Each gets its origin, aliases, kind, slug and primary flag. A gh or key-manager credential goes as it is; a stored token never leaves this environment, so give each one a token there."
          close={close}
          copy={(to) => runtime.forges.copy(environmentId, account, to)}
          line={forgeCopyLine}
        />
      )}
    </section>
  );
};

/** A forge account's verbs answered in one line, said through `say`: whether one is on its way, which takes no second press, and the sender. */
export const useForgeVerb = (say: (line: string) => void) => {
  const [sending, setSending] = useState(false);
  const send = (verb: () => Promise<ForgeOutcome>) => {
    setSending(true);
    void verb().then((done) => {
      setSending(false);
      say(done.line);
    });
  };
  return { sending, send };
};

/** Remove, confirmed: the environment holds the forge account no more, and deletes any token it keeps for it. */
const ConfirmRemove = ({ environmentId, account, close, say }: Omit<ForgeCardProps, "writable"> & { readonly close: () => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState(false);
  const remove = () => {
    setSending(true);
    void removeForge({ runtime, clock }, environmentId, account).then((removed) => {
      setSending(false);
      if (!removed.ok) return setRefused(removed.line);
      close();
      say(removed.line);
    });
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        title={`Remove ${account.origin}?`}
        description={`The environment holds it no more, deleting any token it keeps for it, and runs lose its variables.${account.primary ? " No forge is primary until you choose another." : ""}`}
      >
        {refused !== undefined && <p className="text-sm text-signal">{refused}</p>}
        <div className="flex justify-end gap-2">
          <DialogClose asChild>
            <Button icon={X} label="Cancel">Cancel</Button>
          </DialogClose>
          <Button icon={Trash2} label="Remove" variant="destructive" disabled={sending} onClick={remove}>
            Remove
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
