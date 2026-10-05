import { useState, type ReactNode } from "react";
import type { CapabilityAnswer, EnvironmentView } from "@agent-harness/client-runtime";
import { SCOPES } from "@agent-harness/contracts";
import { X } from "lucide-react";
import { FULL_ACCESS_GUIDANCE, PairingForm } from "./pairing.js";
import { Button, Dialog, DialogContent } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import "./limited-access.css";

/** A disclosure belongs to the client session, so a fresh pairing can be disclosed again. */
export const LimitedAccess = ({ view }: { readonly view: EnvironmentView }) => {
  const [details, showDetails] = useState(false);
  const records = useObservable(useRuntime().connections.list);
  const [dismissed, dismiss] = usePresentation("dismissedPairingAccess");
  const identity = records.find(record => record.environmentId === view.environmentId)?.clientSessionId;
  const limited = SCOPES.some(scope => !view.scopes.includes(scope)) || view.ceiling !== "bypassPermissions";
  if (!limited || !identity || dismissed[view.environmentId] === identity) return null;
  return <><div role="note" aria-label="Limited access" data-limited-access>
    <span>Limited access · </span><Button onClick={() => showDetails(true)}>Details</Button>
    <Button aria-label="Dismiss limited access" onClick={() => dismiss(held => ({ ...held, [view.environmentId]: identity }))}><X aria-hidden="true" /></Button>
  </div><AccessDetails view={view} open={details} onOpenChange={showDetails} /></>;
};

/** Shared capability wording; transport and feature failures retain their original explanation. */
export const AccessUnavailable = ({ environmentId, answer, children }: { readonly environmentId: string; readonly answer: CapabilityAnswer; readonly children: ReactNode }) => {
  const shell = useShell();
  const views = useObservable(useRuntime().projections.environments);
  const [details, showDetails] = useState(false);
  const view = views.find(candidate => candidate.environmentId === environmentId);
  if (shell !== undefined || answer.status !== "absent" || answer.reason !== "scope" || !view) return children;
  return <div data-access-unavailable data-phone-grant-guidance className="flex flex-col items-start gap-2 text-sm text-ink-muted">
    <p>{!view.scopes.includes("terminal") && !view.scopes.includes("admin") ? "Files, changes, terminals and Settings changes are unavailable with this pairing." : !view.scopes.includes("terminal") ? "Files, changes and terminals are unavailable with this pairing." : "Settings changes and provider sign-in are unavailable with this pairing."}</p>
    <Button onClick={() => showDetails(true)}>Give this phone full access</Button>
    <AccessDetails view={view} open={details} onOpenChange={showDetails} pairingFirst />
  </div>;
};

const RIGHTS = [
  ["read", "Read sessions"],
  ["sessions:write", "Create and organise sessions"],
  ["runs:drive", "Send messages and answer permission requests"],
  ["terminal", "Use files, changes and terminals"],
  ["admin", "Change Settings and sign in providers"],
] as const;

const AccessDetails = ({ view, open, onOpenChange, pairingFirst = false }: { readonly view: EnvironmentView; readonly open: boolean; readonly onOpenChange: (open: boolean) => void; readonly pairingFirst?: boolean }) => {
  const [pairing, setPairing] = useState(false);
  const pairingShown = pairingFirst || pairing;
  const close = (next: boolean) => { onOpenChange(next); if (!next) setPairing(false); };
  const standardPhone = view.scopes.includes("read") && view.scopes.includes("sessions:write") && view.scopes.includes("runs:drive");
  return <Dialog open={open} onOpenChange={close}>
    {open && <DialogContent data-access-sheet title={pairingShown ? "Give this phone full access" : "This phone's access"} className="max-w-[32rem] max-h-[calc(100dvh-2rem)] overflow-y-auto" description={pairingShown ? FULL_ACCESS_GUIDANCE : `Paired with ${view.name ?? "this environment"}. Access comes from the code you used.`}>
      {pairingShown ? <PairingForm rePair={view.environmentId} autoFocus onPaired={() => close(false)} /> : <>
        {standardPhone && <p>Read sessions, send messages and answer permission requests. You can also create and organise sessions.</p>}
        <ul className="list-disc pl-5 text-sm">
          {RIGHTS.filter(([scope]) => !standardPhone || ((scope === "terminal" || scope === "admin") && view.scopes.includes(scope))).map(([scope, words]) => <li key={scope}>{words}: {view.scopes.includes(scope) ? "available" : "unavailable"}.</li>)}
        </ul>
        {!view.scopes.includes("terminal") && <p>Files, changes and terminals are unavailable.</p>}
        {!view.scopes.includes("admin") && <p>Settings changes and provider sign-in are unavailable.</p>}
        <p className="text-sm">{view.ceiling === "bypassPermissions" ? "Runs can work without permission checks." : view.ceiling === "acceptEdits" ? "Runs can edit files; other actions may ask for permission." : view.ceiling === "plan" ? "Runs are limited to planning." : view.ceiling === "auto" ? "Runs ask for permission before making changes." : "The run permissions are not known yet."}</p>
        <Button onClick={() => setPairing(true)}>Give this phone full access</Button>
      </>}
    </DialogContent>}
  </Dialog>;
};

/** Grouped Settings writers use the runtime's shared admin failure line. */
export const ReadOnlyAccess = ({ environmentId, line, children }: { readonly environmentId: string; readonly line: string; readonly children: ReactNode }) => {
  const answer = useRuntime().capability(environmentId, "settings.update");
  return <AccessUnavailable environmentId={environmentId} answer={answer.status === "absent" && answer.message === line ? answer : { status: "present" }}>{children}</AccessUnavailable>;
};
