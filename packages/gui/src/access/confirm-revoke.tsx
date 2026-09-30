import type { ClientSessionSummary } from "@agent-harness/client-runtime";
import { Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";

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
 * access"; #417): what revoking does, and, for this client's own client
 * session, that this window loses the environment at once until it pairs
 * again. The dialog belongs to the pane, so a session revoked elsewhere
 * while it asked gets the environment's answer in the pane's line.
 */
export const ConfirmRevoke = ({ environment, session, own, close, revoke }: ConfirmRevokeProps) => (
  <Dialog open onOpenChange={(open) => !open && close()}>
    <DialogContent title={`Revoke ${session.label} on ${environment}?`} description="Its sockets close and its token is refused from then on; the client has to pair again to reach it.">
      {own && (
        <p className="text-sm text-signal">
          This is this client&apos;s own session: this window loses {environment} as soon as it is revoked, until it pairs with {environment} again.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button tone="danger" onClick={revoke}>
          Revoke
        </Button>
      </div>
    </DialogContent>
  </Dialog>
);
