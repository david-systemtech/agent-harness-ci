import { ReadOnlyAccess } from "../connections/limited-access.js";
import { ConnectionGrant } from "../connections/connection-grant.js";
import { WebOrigins } from "./web-origins.js";
import { KeyRound } from "lucide-react";
import { clockTime, rowKeys, type EnvironmentView } from "@agent-harness/client-runtime";
import { NETWORK_SETTINGS_KEYS, type MethodName, type SettingsKey } from "@agent-harness/contracts";
import { useId, useState, type ReactNode } from "react";
import { EnvironmentMark } from "../connections/environment-mark.js";
import { Remedy } from "../connections/remedy.js";
import { UpdateProgress } from "../connections/update-progress.js";
import { THIS_MACHINE, nameOf } from "../connections/words.js";
import { GenericEditor, lackingLines, readOnlyLine, writersOf } from "../settings/generic-editor.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Badge, Button, Fold } from "../ui/index.js";
import { BundledServerOffer, ClientOffer } from "../updates/offers.js";
import { UpdateControls } from "../updates/update-controls.js";
import { useRuntime } from "../window-context.js";
import { ConnectionVerbs } from "./connection-verbs.js";
import { ContainmentAvailability } from "./containment.js";
import { LOOK_COMMANDS, LookEditor } from "./look-editor.js";
import { PresetPairing } from "./preset-pairing.js";
import { Reachability } from "./reachability.js";

/** The keys the row holds: the update keys and the binding keys. */
const ROW_KEYS = rowKeys("environments.machines");

/** The keys drawn by controls of their own: channel and auto-update the update controls', the binding keys the reachability's switches. */
const OWN_CONTROLS: readonly SettingsKey[] = ["updates.channel", "updates.autoUpdate", ...NETWORK_SETTINGS_KEYS];

/** The keys under Advanced, the generic editor's: the pin, the idle window and the deferral cap. */
const ADVANCED_KEYS = ROW_KEYS.filter((key) => !OWN_CONTROLS.includes(key));

/** What the card sends, every one at `admin`: the look commands, a pairing code, the row's keys' writers and Update now. */
const SENT: readonly MethodName[] = [...LOOK_COMMANDS, "access.pairings.create", ...writersOf(ROW_KEYS), "updates.apply"];

/**
 * The local environment's service down, as its card says it beside Start
 * (ADR 0025's "service down"), since when it was last reached where it
 * was; undefined for any other phase, which the card says as every pane
 * does.
 */
const serviceDownWords = (view: EnvironmentView): string | undefined => {
  if (view.phase !== "service-down") return undefined;
  return view.unreachableSince === null ? "Service down" : `Service down since ${clockTime(view.unreachableSince)}`;
};

/** A part of a card, under its heading. */
export const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="overflow-hidden rounded-lg border border-hairline">
      <h4 id={heading} className="border-b border-hairline px-3 py-2 text-xs font-medium text-ink">
        {title}
      </h4>
      <div className="flex flex-col gap-3 p-3">{children}</div>
    </section>
  );
};

interface MachineCardProps {
  readonly view: EnvironmentView;
  /** Another environment of the same name, which the card says. */
  readonly namesake: EnvironmentView | undefined;
  /** The desktop's secrets keep tokens under no key the OS keeps (#395), which a paired environment's card says of its token. */
  readonly unprotected: boolean;
  /** Says on the pane what forgetting the connection did, since the card goes with it. */
  readonly forgotten: (line: string) => void;
  /** What the card offers first, under its heading: Set up this machine, on a card Add a machine made (#577). */
  readonly offer?: ReactNode;
}

/**
 * One environment's card on Your machines (ADR 0025; #416, #576): its name,
 * its icon in its colour, whether it is this machine's and the primary one,
 * another environment of the same name, how it is reached with its binding
 * switches, its containment availability with a link to Permissions, a
 * pairing code for another client and Manage access, its update controls
 * with the offer of this client's newer version (and, on the local
 * environment's card, of the newer server the desktop carries) and its
 * other update keys under Advanced (#424), and what this client does with
 * its connection. While it is not ready, it
 * says since when it has not been reached, or that its service is down (or
 * why not) above everything it shows as last read, read-only, with what the
 * connection offers (Start, Pair again, Try again); without `admin`, that
 * it is read-only, with the capability's line; and on a paired
 * environment's card, when the desktop stores tokens unprotected, that its
 * token is.
 */
export const MachineCard = ({ view, namesake, unprotected, forgotten, offer }: MachineCardProps) => {
  const runtime = useRuntime();
  const heading = useId();
  const [advanced, setAdvanced] = useState(false);
  const admits = (method: MethodName) => runtime.capability(view.environmentId, method).status === "present";
  const lacking = view.phase === "ready" ? lackingLines(runtime, view.environmentId, SENT) : [];
  return (
    <section data-machine-card data-environment-id={view.environmentId} data-machine-kind={view.kind} data-machine-phase={view.phase} data-machine-blocked={view.blocked ?? undefined} data-machine-action={view.action ?? undefined} aria-labelledby={heading} className="flex min-w-0 flex-col gap-3.5 rounded-lg border border-hairline bg-panel p-3">
      <header className="flex flex-wrap items-center gap-2 [&>svg]:size-4">
        <EnvironmentMark view={view} />
        <h3 id={heading} className="text-sm font-semibold text-ink">
          {view.name ?? THIS_MACHINE}
        </h3>

        {view.kind === "local" && view.name !== null && <Badge variant="secondary">{THIS_MACHINE}</Badge>}
        {view.phase === "ready" && <Badge variant="secondary">Ready</Badge>}
        {view.primary && <Badge variant="outline">Primary</Badge>}
      </header>
      <ConnectionGrant view={view} />
      {offer}
      {namesake !== undefined && <p className="text-sm text-amber">Another of your machines is named {namesake.name} too: rename one to tell them apart.</p>}
      {view.phase !== "ready" && (
        <div className="flex flex-wrap items-center gap-2">
          {/* What the card shows of it (its name, icon and colour first) was read once it had answered, which a name says. */}
          <p className="text-sm text-amber">{readOnlyLine(runtime, view, view.name !== null, serviceDownWords(view))}</p>
          <Remedy view={view} />
        </div>
      )}
      {unprotected && view.kind === "paired" && (
        // A paired connection's token is the one this client keeps in its secrets; the local one's is held in memory.
        <p className="text-sm text-amber">
          Tokens are stored unprotected on this desktop: no secret service answers, so this client's token for {nameOf(view)} is as safe as its file's permissions.
        </p>
      )}
      {lacking.map((line) => (
        <ReadOnlyAccess key={line} environmentId={view.environmentId} line={line}><p className="text-sm text-amber">Read-only: {line}</p></ReadOnlyAccess>
      ))}
      <Part title="Identity"><LookEditor view={view} writable={LOOK_COMMANDS.every(admits)} /></Part>
      <Part title="Reachability">
        <Reachability view={view} writable={admits("settings.update")} />
      </Part>
      <WebOrigins view={view} />
      <Part title="Containment">
        <ContainmentAvailability view={view} />
      </Part>
      <Part title="Pair another client">
        <PresetPairing view={view} writable={admits("access.pairings.create")} />
        <ManageAccess view={view} />
      </Part>
      <Part title="Updates">
        <UpdateControls view={view} />
        <ClientOffer view={view} />
        <UpdateProgress view={view} />
        {view.kind === "local" && <BundledServerOffer view={view} />}
        <Fold summary="Advanced" open={advanced} onOpenChange={setAdvanced}>
          <GenericEditor view={view} keys={ADVANCED_KEYS} saysWhyReadOnly={false} />
        </Fold>
      </Part>
      <Part title="Connection">
        <ConnectionVerbs view={view} forgotten={forgotten} />
      </Part>
    </section>
  );
};

/**
 * Manage access: the environment's access list in Settings (its client
 * sessions, ceilings and program pairings, ADR 0025), leaving the full
 * checklist when the card is drawn there.
 */
const ManageAccess = ({ view }: { readonly view: EnvironmentView }) => {
  const { open } = useSettings();
  const checklist = useChecklist();
  const manage = () => (checklist.shown ? checklist.leave("environments.access", view.environmentId) : open("environments.access", view.environmentId));
  return (
    <div>
      <Button onClick={manage} title="Manage access (Enter or Space)"><KeyRound aria-hidden="true" data-icon="inline-start" />Manage access</Button>
    </div>
  );
};
