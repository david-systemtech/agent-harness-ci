import { LOCAL_PLACEHOLDER_ID, homeEnvironment, installLines, type EnvironmentView } from "@agent-harness/client-runtime";
import { ReleaseChannel } from "@agent-harness/contracts";
import { useId, useMemo, useState } from "react";
import { PairingForm } from "../connections/pairing.js";
import { nameOf } from "../connections/words.js";
import { ExternalLink } from "../session/external-link.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useSettings } from "../settings/settings-window.js";
import { Button, Field, Input } from "../ui/index.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { Part } from "./machine-card.js";

/** A line to copy: its text to select, and Copy where the shell has a clipboard. */
const CopyLine = ({ label, text }: { readonly label: string; readonly text: string }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const heading = useId();
  const clipboard = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.clipboard").status === "present" ? shell?.clipboard : undefined;
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-1">
      <h5 id={heading} className="text-xs text-ink-muted">
        {label}
      </h5>
      <div className="flex items-start gap-2">
        <pre className="min-w-0 flex-1 rounded-md bg-inset p-2 font-mono text-xs break-all whitespace-pre-wrap text-ink select-all">{text}</pre>
        {clipboard !== undefined && <Button onClick={() => void clipboard.writeText(text)}>Copy</Button>}
      </div>
    </section>
  );
};

/**
 * The lines that install another machine from `view`'s release (the Set
 * up spec, "Add a machine"; launcher-update spec; #577): the environment's
 * version and release source (`updates.status`) and its channel
 * (`settings.get`), each from the request cache, with the name typed.
 */
const InstallLinesOf = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const status = useObservable(useMemo(() => runtime.requests.cached(view.environmentId, "updates.status", {}), [runtime, view.environmentId]));
  const channel = ReleaseChannel.safeParse(useSettingsValues(view.environmentId).values?.["updates.channel"]);
  const [name, setName] = useState("");
  const readable = runtime.capability(view.environmentId, "updates.status");
  if (status.result === null || !channel.success) {
    const why = readable.status === "absent" ? readable.message : status.error !== null ? status.error.message : undefined;
    return (
      <p className="text-sm text-ink-muted">
        {why === undefined ? `Reading ${nameOf(view)}'s release and channel…` : `The install lines need ${nameOf(view)}'s release and channel: ${why}`}
      </p>
    );
  }
  const lines = installLines({ releaseSource: status.result.releaseSource, version: status.result.version, channel: channel.data, name });
  return (
    <>
      <p className="text-sm text-ink">
        Each installs the environment from {nameOf(view)}'s release, {status.result.version}, on its channel, {channel.data}, and ends by printing the new machine's pairing link, QR
        and code, for Pair with it. Set AGENT_HARNESS_TOKEN to a Forgejo token with read:repository first: the line hands it to curl on its standard input, never on a
        command line.
      </p>
      <Field label="Name (optional)">
        <Input value={name} placeholder="The new machine's hostname" onChange={(event) => setName(event.target.value)} />
      </Field>
      <CopyLine label="macOS and Linux" text={lines.unix} />
      <CopyLine label="Windows (PowerShell)" text={lines.windows} />
      <CopyLine label="A container (Docker or Podman), from the folder to keep its compose file in" text={lines.compose.join("\n")} />
      <p className="text-sm text-ink-muted">
        Until a client first pairs with it, the container prints its pairing link, QR and code to its log at each start, which the last line shows. Its name and channel are set on
        its card once paired. It never updates itself: the host-side updater does, from the host.
      </p>
      <p className="text-sm">
        <ExternalLink url={lines.updaterDocs}>The host-side updater's documentation</ExternalLink>
      </p>
    </>
  );
};

/**
 * Add a machine (ADR 0025; the Set up spec, "Your machines"; #577), the
 * card after the environments' on Your machines: Pair with it, a link or a
 * code pasted (or a QR scanned where the platform gives the window a
 * camera, else why not), whose exchange makes the machine a card, which
 * `added` hears; and Install on another machine, the lines from the home
 * environment's release. Opened at it (Set up's "Set up another machine"),
 * the link's field takes the focus.
 */
export const AddAMachine = ({ added }: { readonly added: (environmentId: string) => void }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const { part } = useSettings();
  const home = homeEnvironment(useObservable(runtime.projections.environments));
  const heading = useId();
  const camera = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.camera");
  const lens = camera.status === "present" ? shell?.camera : undefined;
  const scanQr = lens === undefined ? undefined : () => lens.scanQr();
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-3 rounded-md border border-line p-4">
      <h3 id={heading} className="text-sm font-semibold text-ink">
        Add a machine
      </h3>
      <Part title="Pair with it">
        <p className="text-sm text-ink-muted">Paste the link or the code the other machine shows: in its own Set up, from its terminal's pair, or in the install script's last lines.</p>
        <PairingForm onPaired={added} scanQr={scanQr} autoFocus={part === "add-a-machine"} />
        {camera.status === "absent" && <p className="text-xs text-ink-faint">Scan a QR: {camera.message}</p>}
      </Part>
      <Part title="Install on another machine">
        {home === undefined ? <p className="text-sm text-ink-muted">No environment of yours has answered yet, so there is no release to install from.</p> : <InstallLinesOf view={home} />}
      </Part>
    </section>
  );
};
