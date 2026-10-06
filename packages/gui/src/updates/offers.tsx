import { bundledServerWords, clientOfferAskWords, clientOfferWords, clientUpdateWords, offersClientVersion, type ActionOutcome, type BundledServerView, type EnvironmentView } from "@agent-harness/client-runtime";
import { ArrowDownToLine } from "lucide-react";
import { useState } from "react";
import { nameOf } from "../connections/words.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClientVersion, useObservable, useRuntime } from "../window-context.js";
import { useUpdatesStatus } from "./use-updates-status.js";

/** Whether the local environment's update from the server the desktop carries is offered or under way, which is the offer of this version there. */
const carriedOffer = (bundled: BundledServerView): boolean => bundled.state === "offered" || bundled.state === "handing-over" || bundled.state === "handed-over";

/**
 * The offer of this client's version to an environment that runs an older
 * one (launcher-update spec, "a newer client offers to update the
 * environment to its version"; #424), made by the connection registry's
 * `update-environment` action: `updates.apply` of this client's version when
 * idle, or `POST /api/update` for an environment blocked on the protocol,
 * which the wire refuses. No offer while an update under way there goes as
 * far already, nor on the local environment's card while the server the
 * desktop carries is offered there. What the ask came to is one line, its
 * status, in the signal colour when the update was not taken.
 */
export const ClientOffer = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const client = useClientVersion();
  const status = useUpdatesStatus(view.environmentId);
  const { bundledServer } = useObservable(runtime.desktopUpdate.view);
  const [asking, setAsking] = useState(false);
  const [said, setSaid] = useState<ActionOutcome | undefined>(undefined);
  const name = nameOf(view);
  const version = status.result?.version ?? view.version;
  const offered = version !== null && offersClientVersion(client, version, status.result?.pending ?? null) && !(view.kind === "local" && carriedOffer(bundledServer));
  const writable = view.action === "update-environment" || (view.phase === "ready" && runtime.capability(view.environmentId, "updates.apply").status === "present");

  const ask = () => {
    setAsking(true);
    setSaid(undefined);
    void runtime.connections
      .updateEnvironment(view.environmentId)
      .then(
        (outcome) => setSaid({ ok: outcome.ok, line: clientUpdateWords(outcome, name) }),
        (error: unknown) => setSaid({ ok: false, line: `Not updated: ${error instanceof Error ? error.message : String(error)}` }),
      )
      .finally(() => setAsking(false));
  };

  if (!offered && said === undefined) return null;
  return (
    <div className="flex flex-col items-start gap-1 text-sm">
      {offered && (
        <>
          <p className="text-ink">{clientOfferWords(client, name, version)}</p>
          <Tooltip content="Update environment" keys="Enter / Space"><Button variant="default" disabled={!writable || asking} onClick={ask}>
            <ArrowDownToLine aria-hidden="true" />{clientOfferAskWords(client, name)}
          </Button></Tooltip>
        </>
      )}
      {said !== undefined && <p role="status" className={said.ok ? "text-ink-muted" : "text-signal"}>{said.line}</p>}
    </div>
  );
};

/**
 * The server artefact the desktop carries, on the local environment's card
 * (launcher-update spec, "The desktop moves with its local environment";
 * #424): newer than the environment runs, it is handed over by itself when
 * auto-update is effective there; otherwise it is offered here, and a click
 * hands it over (`desktopUpdate.applyBundledServer`), under the idle rules,
 * with no download. Says where it is, or why it was not taken.
 */
export const BundledServerOffer = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { bundledServer } = useObservable(runtime.desktopUpdate.view);
  const words = bundledServerWords(bundledServer, nameOf(view));
  if (words === null) return null;
  const offered = bundledServer.state === "offered" || (bundledServer.state === "failed" && bundledServer.version !== null) ? bundledServer.version : null;
  const writable = view.phase === "ready" && runtime.capability(view.environmentId, "updates.apply").status === "present";
  return (
    <div className="flex flex-col items-start gap-1 text-sm">
      <p className={bundledServer.state === "failed" ? "text-signal" : "text-ink"}>{words}</p>
      {offered !== null && (
        <Tooltip content="Install bundled environment" keys="Enter / Space"><Button variant="default" disabled={!writable} onClick={() => void runtime.desktopUpdate.applyBundledServer()}>
          <ArrowDownToLine aria-hidden="true" />Install the bundled {offered}
        </Button></Tooltip>
      )}
    </div>
  );
};
