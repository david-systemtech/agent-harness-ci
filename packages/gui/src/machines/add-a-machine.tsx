import { webCameraFor } from "../platform/web-camera.js";
import { LOCAL_PLACEHOLDER_ID, homeEnvironment, installLines, type EnvironmentView } from "@agent-harness/client-runtime";
import { ReleaseChannel } from "@agent-harness/contracts";
import { Laptop, TextCursorInput } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { PairingForm, PairingRefusal } from "../connections/pairing.js";
import { nameOf } from "../connections/words.js";
import { ExternalLink } from "../session/external-link.js";
import { CopyLine } from "../settings/copy-line.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { useSettings } from "../settings/settings-window.js";
import { Field, Fold, Input } from "../ui/index.js";
import { useUpdatesStatus } from "../updates/use-updates-status.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { Part } from "./machine-card.js";
import { PresetPairing } from "./preset-pairing.js";

/** Above Make a pairing code while this computer binds loopback alone (setup-copy.md §5.5). */
export const ONLY_FROM_ITSELF = "Other devices cannot reach this computer yet, so they cannot use a code made now. Set up Tailscale first.";

/** Numbered steps, read in order. */
const Steps = ({ steps }: { readonly steps: readonly string[] }) => (
  <ol className="flex list-none flex-col gap-0.5 text-sm text-ink">
    {steps.map((step) => <li key={step}>{step}</li>)}
  </ol>
);

/**
 * Part 1, a code for another device to connect to this computer (setup-copy.md
 * §5.5): who it is for, and, while this computer binds loopback alone, so
 * that any code it makes carries a 127.0.0.1 link no other device can use,
 * the warning above the button (#1847). How it is reached is
 * `environment.status`'s binding, from the request cache: a proxy's HTTPS
 * origin, which the links carry then, reaches it on loopback alone.
 */
const ConnectToThisOne = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const { environmentId } = view;
  const status = useObservable(useMemo(() => runtime.requests.cached(environmentId, "environment.status", {}), [runtime, environmentId]));
  const binding = status.result?.binding;
  const onlyFromItself = binding != null && binding.tailnet === null && binding.lan === null && binding.webOrigin === undefined;
  return (
    <PresetPairing
      view={view}
      writable={runtime.capability(environmentId, "access.pairings.create").status === "present"}
      warning={onlyFromItself ? <p data-only-from-itself className="text-sm text-amber">{ONLY_FROM_ITSELF}</p> : undefined}
    />
  );
};

/**
 * Part 3, installing agent-harness on another computer from `view`'s release
 * (setup-copy.md §5.5; launcher-update spec; #577): the numbered steps, a
 * line per system with Copy, and the container's in a fold with the
 * updater's guide; each from the environment's version and release source
 * (`updates.status`) and its channel (`settings.get`), from the request
 * cache, with the name typed.
 */
const InstallLinesOf = ({ view }: { readonly view: EnvironmentView }) => {
  const runtime = useRuntime();
  const status = useUpdatesStatus(view.environmentId);
  const channel = ReleaseChannel.safeParse(useSettingsValues(view.environmentId).values?.["updates.channel"]);
  const [name, setName] = useState("");
  const [container, setContainer] = useState(false);
  const readable = runtime.capability(view.environmentId, "updates.status");
  if (status.result === null || !channel.success) {
    const why = readable.status === "absent" ? readable.message : status.error !== null ? status.error.message : undefined;
    return why === undefined
      ? <p className="text-sm text-ink-muted">Checking which version to install…</p>
      : <PairingRefusal line="This app cannot tell which version to install yet." details={[why]} computer={nameOf(view)} />;
  }
  const lines = installLines({ releaseSource: status.result.releaseSource, version: status.result.version, channel: channel.data, name });
  return (
    <>
      <Steps steps={["1. On the other computer, open a terminal.", "2. Copy the line for its system and paste it.", "3. When it finishes, it shows a pairing link. Paste it in Part 2."]} />
      {status.result.releaseSource.kind !== "github" && (
        <p className="text-sm text-ink">
          This release is private. Before you paste a line, set <code className="font-mono">AGENT_HARNESS_TOKEN</code> to a token that can read it.
        </p>
      )}
      <div className="flex items-start gap-2"><TextCursorInput aria-hidden="true" className="mt-1 size-4 shrink-0" /><Field label="Name for the new computer (optional)" className="flex-1">
        <Input title="Name for the new computer (optional; type a name)" value={name} onChange={(event) => setName(event.target.value)} />
      </Field></div>
      <CopyLine label="Mac or Linux" text={lines.unix} />
      <CopyLine label="Windows (PowerShell)" text={lines.windows} />
      <Fold summary="Using Docker or Podman?" open={container} onOpenChange={setContainer}>
        <div className="flex flex-col gap-2">
          <Steps steps={["1. Make a folder for it and open a terminal there.", "2. Copy this line and paste it.", "3. The pairing link appears in the container's log.", "4. To keep it up to date, set up the host updater."]} />
          <CopyLine label="Docker or Podman" text={lines.compose.join("\n")} />
          <p className="text-sm">
            <ExternalLink url={lines.updaterDocs}>How to set up the updater</ExternalLink>
          </p>
        </div>
      </Fold>
    </>
  );
};

/**
 * Add a device (setup-copy.md §5.5; ADR 0025; #577, #1847), the card after
 * the computers' on Your machines, in three parts: a code for another device
 * to connect to this computer; this app connecting to another computer, the
 * pairing form of §4.2 (a link or a code pasted, or a QR scanned where the
 * platform gives the window a camera, else why not), whose exchange makes the
 * computer a card, which `added` hears; and installing agent-harness on
 * another computer, the lines from the home environment's release. Opened at
 * it (Set up's "Set up another computer"), the link's field takes the focus.
 */
export const AddAMachine = ({ added }: { readonly added: (environmentId: string) => void }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const { part, open } = useSettings();
  const home = homeEnvironment(useObservable(runtime.projections.environments));
  const heading = useId();
  const camera = runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.camera");
  const lens = camera.status === "present" ? shell?.camera : undefined;
  const scanQr = lens === undefined ? undefined : () => lens.scanQr();
  const unanswered = <p className="text-sm text-ink-muted">This app has not reached agent-harness on this computer yet.</p>;
  return (
    <section aria-labelledby={heading} className="flex min-w-0 flex-col gap-3.5 rounded-lg border border-hairline bg-panel p-3">
      <h3 id={heading} className="flex items-center gap-2 text-sm font-semibold text-ink">
        <Laptop aria-hidden="true" className="size-4" />Add a device
      </h3>
      <Part title="Connect a phone or computer to this one">
        {home === undefined ? unanswered : <ConnectToThisOne key={home.environmentId} view={home} />}
      </Part>
      <Part title="Connect this app to another computer">
        <PairingForm onPaired={added} scanQr={scanQr} autoFocus={part === "add-a-machine"} toBrowserOrigins={(environmentId) => open("environments.machines", environmentId, "browser-origins")} />
        {camera.status === "absent" && webCameraFor(runtime) === undefined && <p className="text-xs text-ink-faint">{camera.message}</p>}
      </Part>
      <Part title="Install agent-harness on another computer">
        {home === undefined ? unanswered : <InstallLinesOf view={home} />}
      </Part>
    </section>
  );
};
