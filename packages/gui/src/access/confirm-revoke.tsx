import { DialogFooter } from "../ui/dialog.js";
import { KeyRound, X } from "lucide-react";
import { clientSessionWords, type ClientSessionSummary } from "@agent-harness/client-runtime";
import { Badge, Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useClock } from "../window-context.js";

export interface ConfirmRevokeProps {
  /** The environment's name, as the pane's picker names it. */
  readonly environment: string;
  readonly session: ClientSessionSummary;
  /** Whether it is this client's own client session there, which the dialog warns of. */
  readonly own: boolean;
  readonly close: () => void;
  readonly revoke: () => void;
}

/**
 * Revoke, once confirmed (`access.sessions.revoke`; env spec, "Pairing and
 * access"; #417): which client session, by its label and its row's line
 * with when it paired (#1740), this client's own marked; what revoking does;
 * and, for this client's own client session, that this window loses the
 * environment at once until it pairs again. The dialog belongs to the pane, so a session revoked elsewhere
 * while it asked gets the environment's answer in the pane's line.
 */
export const ConfirmRevoke = ({ environment, session, own, close, revoke }: ConfirmRevokeProps) => {
  const clock = useClock();
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent showClose={false} data-revoke-confirmation title={`Revoke ${session.label} on ${environment}?`} description="Its sockets close and its token is refused from then on; the client has to pair again to reach it.">
        <div className="mb-2 flex size-10 items-center justify-center rounded-md bg-signal/10 text-signal"><KeyRound aria-hidden="true" className="size-6" /></div>
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
          <span>{clientSessionWords(session, clock.now())}</span>
          {own && <Badge variant="secondary">This client</Badge>}
        </p>
        {own && (
          <p className="rounded-lg bg-signal/10 p-3 text-sm text-signal">
            This is this client&apos;s own session: this window loses {environment} as soon as it is revoked, until it pairs with {environment} again.
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button title="Cancel (Enter, Space or Escape)"><X aria-hidden="true" data-icon="inline-start" />Cancel</Button>
          </DialogClose>
          <Button variant="destructive" onClick={revoke} title="Revoke (Enter or Space)">
            <KeyRound aria-hidden="true" data-icon="inline-start" />Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
