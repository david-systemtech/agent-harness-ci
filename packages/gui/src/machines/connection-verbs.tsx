import type { EnvironmentView, RemoveResult } from "@agent-harness/client-runtime";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { Button, Dialog, DialogClose, DialogContent } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What forgetting did, in one line: the client session revoked there, or why it still stands (ADR 0025). */
const forgottenLine = (name: string, result: RemoveResult): string =>
  result.revoked ? `Forgot ${name} and revoked this client's session there.` : `Forgot ${name}. ${result.message}`;

/**
 * What the connection registry does with a connection, from its card (ADR
 * 0025; #416), each a client-local call that needs no scope: disable or
 * enable it, make it the primary environment (first in the saved sequence),
 * and forget it, after asking once. Forgetting revokes this client's session
 * there when it can be reached, and says so, on the pane, since the card
 * goes with it; the local environment is never forgotten, its connection
 * coming from its grant on every start.
 */
export const ConnectionVerbs = ({ view, forgotten }: { readonly view: EnvironmentView; readonly forgotten: (line: string) => void }) => {
  const runtime = useRuntime();
  const [asking, setAsking] = useState(false);
  const [line, setLine] = useState<string | undefined>(undefined);
  const name = nameOf(view);

  const run = async (refused: string, call: () => Promise<unknown>) => {
    setLine(undefined);
    try {
      await call();
    } catch (error) {
      setLine(`${refused}: ${messageOf(error)}`);
    }
  };
  const makePrimary = () =>
    run("Not made primary", () => {
      // The whole saved sequence, disabled connections included: `setOrder` names each once.
      const others = runtime.projections.environments.read().filter((other) => other.environmentId !== view.environmentId);
      return runtime.connections.setOrder([view.environmentId, ...others.map((other) => other.environmentId)]);
    });
  const forget = () =>
    run("Not forgotten", async () => {
      setAsking(false);
      forgotten(forgottenLine(name, await runtime.connections.remove(view.environmentId)));
    });

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {view.enabled ? (
          <Button onClick={() => void run("Not disabled", () => runtime.connections.setEnabled(view.environmentId, false))}>Disable</Button>
        ) : (
          <Button onClick={() => void run("Not enabled", () => runtime.connections.setEnabled(view.environmentId, true))}>Enable</Button>
        )}
        {!view.primary && <Button onClick={() => void makePrimary()}>Make primary</Button>}
        {view.kind === "paired" && (
          <Button tone="danger" onClick={() => setAsking(true)}>
            Forget…
          </Button>
        )}
      </div>
      {line !== undefined && <p className="text-sm text-signal">{line}</p>}
      <Dialog open={asking} onOpenChange={setAsking}>
        {asking && (
          <DialogContent
            title={`Forget ${name}?`}
            description={
              view.unreachableSince === null
                ? `This client forgets ${name} and revokes its client session there.`
                : `${name} cannot be reached now, so this client forgets it here, and its client session there stays until it is revoked from that machine's access list.`
            }
          >
            <div className="flex justify-end gap-2">
              <DialogClose asChild>
                <Button>Cancel</Button>
              </DialogClose>
              <Button tone="danger" onClick={() => void forget()}>
                Forget
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
};
