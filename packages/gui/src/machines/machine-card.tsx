import { rowKeys, type EnvironmentView } from "@agent-harness/client-runtime";
import type { MethodName } from "@agent-harness/contracts";
import { useId, type ReactNode } from "react";
import { EnvironmentMark } from "../connections/environment-mark.js";
import { Remedy } from "../connections/remedy.js";
import { THIS_MACHINE, nameOf } from "../connections/words.js";
import { GenericEditor, lackingLines, readOnlyLine, writersOf } from "../settings/generic-editor.js";
import { BundledServerOffer, ClientOffer } from "../updates/offers.js";
import { UpdateControls } from "../updates/update-controls.js";
import { useRuntime } from "../window-context.js";
import { ConnectionVerbs } from "./connection-verbs.js";
import { ContainmentAvailability } from "./containment.js";
import { LOOK_COMMANDS, LookEditor } from "./look-editor.js";
import { PresetPairing } from "./preset-pairing.js";

/** The keys the row holds, the update keys: channel and auto-update are the update controls', the rest the generic editor's. */
const UPDATE_KEYS = rowKeys("environments.machines");

/** The update keys the update controls do not draw: the pin, the idle window and the deferral cap. */
const OTHER_UPDATE_KEYS = UPDATE_KEYS.filter((key) => key !== "updates.channel" && key !== "updates.autoUpdate");

/** What the card sends, every one at `admin`: the look commands, a pairing code, the update keys' writer and Update now. */
const SENT: readonly MethodName[] = [...LOOK_COMMANDS, "access.pairings.create", ...writersOf(UPDATE_KEYS), "updates.apply"];

/** A part of a card, under its heading. */
export const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2">
      <h4 id={heading} className="text-xs font-semibold text-ink-muted">
        {title}
      </h4>
      {children}
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
 * One environment's card on Your machines (ADR 0025; #416): its name, its
 * icon in its colour, whether it is this machine's and the primary one,
 * another environment of the same name, its containment availability, a
 * pairing code for another client, its update controls with the offer of
 * this client's newer version (and, on the local environment's card, of the
 * newer server the desktop carries) and its other update keys (#424), and
 * what this client does with its connection. While it is not ready, it
 * says since when it has not been reached (or why not) above everything it
 * shows as last read, read-only, with what the connection offers (Start,
 * Pair again, Try again); without `admin`, that it is read-only, with the
 * capability's line; and on a paired environment's card, when the desktop
 * stores tokens unprotected, that its token is.
 */
export const MachineCard = ({ view, namesake, unprotected, forgotten, offer }: MachineCardProps) => {
  const runtime = useRuntime();
  const heading = useId();
  const admits = (method: MethodName) => runtime.capability(view.environmentId, method).status === "present";
  const lacking = view.phase === "ready" ? lackingLines(runtime, view.environmentId, SENT) : [];
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h3 id={heading} className="text-sm font-semibold text-ink">
          {view.name ?? THIS_MACHINE}
        </h3>
        <EnvironmentMark view={view} />
        {view.kind === "local" && view.name !== null && <span className="text-xs text-ink-faint">{THIS_MACHINE}</span>}
        {view.primary && <span className="text-xs text-ink-faint">Primary</span>}
      </header>
      {offer}
      {namesake !== undefined && <p className="text-sm text-amber">Another of your machines is named {namesake.name} too: rename one to tell them apart.</p>}
      {view.phase !== "ready" && (
        <div className="flex flex-wrap items-center gap-2">
          {/* What the card shows of it (its name, icon and colour first) was read once it had answered, which a name says. */}
          <p className="text-sm text-amber">{readOnlyLine(runtime, view, view.name !== null)}</p>
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
        <p key={line} className="text-sm text-amber">
          Read-only: {line}
        </p>
      ))}
      <LookEditor view={view} writable={LOOK_COMMANDS.every(admits)} />
      <Part title="Containment">
        <ContainmentAvailability view={view} />
      </Part>
      <Part title="Pair another client">
        <PresetPairing view={view} writable={admits("access.pairings.create")} />
      </Part>
      <Part title="Updates">
        <UpdateControls view={view} />
        <ClientOffer view={view} />
        {view.kind === "local" && <BundledServerOffer view={view} />}
        <GenericEditor view={view} keys={OTHER_UPDATE_KEYS} saysWhyReadOnly={false} />
      </Part>
      <Part title="Connection">
        <ConnectionVerbs view={view} forgotten={forgotten} />
      </Part>
    </section>
  );
};
