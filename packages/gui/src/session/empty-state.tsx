import { actionById, PRODUCT_NAME } from "@agent-harness/contracts";
import { FolderOpen, KeyRound, Link, PanelLeft, Plus, SquareTerminal, TriangleAlert } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { useOpenPairing } from "../connections/pairing.js";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { keyLabel } from "../keys/chords.js";
import { useFirstKey, useKeyMap, useMacOS } from "../keys/key-dispatch.js";
import { DEFAULT_KEY_MAP, keysInForce, type KeyMap } from "../keys/key-map.js";
import { useStartNewSession } from "../new-session/control.js";
import { useSettings } from "../settings/settings-window.js";
import { Alert, AlertDescription, AlertTitle, Button, Kbd, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

const LEGEND = [
  ["composer.send", "Send the prompt"], ["composer.newline", "New line"],
  ["app.palette", "Commands, sessions and settings"], ["permission.deny", "Dismiss a dialog or deny a prompt"],
  ["app.session.new", "New session"], ["app.sidebar.toggle", "Show or hide the sidebar"],
  ["app.settings.toggle", "Settings"], ["app.runInfo.toggle", "Run details"],
] as const;

/** The welcome geometry and key legend are shared by ready, local-start and pairing states.
 * The phone layout has no keyboard to press them with, so it draws no legend (#1715). */
export const Welcome = ({ children, sentence = "A place to work with coding agents.", keyMap = DEFAULT_KEY_MAP, macOS = false }: {
  readonly children?: ReactNode;
  readonly sentence?: string;
  readonly keyMap?: KeyMap;
  readonly macOS?: boolean;
}) => {
  const { narrow } = usePhoneFrame();
  return <div data-welcome className="@container flex min-h-[60vh] min-w-0 flex-1 flex-col items-center justify-center gap-6 px-8 py-12">
    <div className="flex w-full max-w-[512px] flex-col items-center gap-6">
      <div data-welcome-tile className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-beam text-beam-ink">
        <SquareTerminal aria-hidden="true" className="size-[22px]" />
      </div>
      <div className="text-center">
        <h2 className="text-base font-semibold text-ink">{PRODUCT_NAME}</h2>
        <p className="mt-2 text-xs text-ink-muted">{sentence}</p>
      </div>
      {children}
      {!narrow && <ul aria-label="Keyboard shortcuts" className="grid w-full grid-cols-1 gap-x-5 gap-y-2 @[440px]:grid-cols-2">
        {LEGEND.map(([id, description]) => {
          const action = actionById(id);
          const key = action === undefined ? undefined : keysInForce(action, keyMap)[0];
          return <li key={id} className="flex items-center gap-3 text-2xs text-ink-faint">
            <Kbd className="min-w-8 shrink-0 font-mono">{key === undefined ? "Unbound" : keyLabel(key, macOS)}</Kbd>
            <span>{id === "permission.deny" && key !== "Esc" ? "Deny a prompt" : description}</span>
          </li>;
        })}
      </ul>}
    </div>
  </div>;
};

export const EmptyState = () => {
  const runtime = useRuntime();
  const keyMap = useKeyMap();
  const macOS = useMacOS();
  const settings = useSettings();
  const openPairing = useOpenPairing();
  const start = useStartNewSession();
  const phone = usePhoneFrame();
  const sessionKey = useFirstKey("app.session.new");
  const settingsKey = useFirstKey("app.settings.toggle");
  const view = useObservable(useMemo(() => runtime.projections.newSession({ focus: { kind: "none" } }), [runtime]));
  const environmentId = view.environment.value;
  return <Welcome keyMap={keyMap} macOS={macOS} sentence={phone.narrow ? "No session is open. Choose one or start a new one." : "No session is open. Choose one from the sidebar."}>
    <Alert className="w-full text-left">
      <TriangleAlert aria-hidden="true" className="text-amber" />
      <AlertTitle>Not ready to run</AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {environmentId === null && <p>No environment is ready. <Tooltip content="Pair with an environment"><Button variant="link" size="xs" onClick={() => openPairing()}><Link aria-hidden="true" />Pair with an environment</Button></Tooltip></p>}
        {environmentId !== null && view.account.value === null && <p>No signed-in account. <Tooltip content="Add an account in Settings" keys={settingsKey}>
          <Button variant="link" size="xs" onClick={() => settings.open("accounts.accounts", environmentId ?? undefined)}><KeyRound aria-hidden="true" />Add an account</Button>
        </Tooltip></p>}
        <p>Choose where your new session will work. <Tooltip content="Choose a workspace in a new session" keys={sessionKey}>
          <Button variant="link" size="xs" onClick={() => start.here({ environmentId })}><FolderOpen aria-hidden="true" />Choose a workspace</Button>
        </Tooltip></p>
      </AlertDescription>
    </Alert>
    <Tooltip content="New session" keys={sessionKey}>
      <Button variant="default" onClick={() => start.here({ environmentId })}><Plus aria-hidden="true" />Start a new session</Button>
    </Tooltip>
    {phone.narrow && <Button variant="outline" onClick={event => phone.showDrawer(true, { opener: event.currentTarget })}><PanelLeft aria-hidden="true" />Choose a session</Button>}
  </Welcome>;
};
