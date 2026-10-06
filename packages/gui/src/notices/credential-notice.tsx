import type { SecretAccess } from "@agent-harness/client-runtime";
import { ArrowRight, TriangleAlert, X } from "lucide-react";
import { createContext, use, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSettingsNoticeHost } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button, IconButton } from "../ui/index.js";
import { useClock, useShell } from "../window-context.js";

const CredentialHostContext = createContext<{ host: HTMLDivElement | null; setHost: (host: HTMLDivElement | null) => void } | null>(null);
/** How long an OS credential request waits before the window says macOS is asking: a request answered at once says nothing. */
export const KEYCHAIN_NOTICE_DELAY_MS = 500;

/** The active view supplies a place for the window's one persistent credential notice. */
export const CredentialNoticeHost = () => {
  const view = use(CredentialHostContext);
  return <div ref={view?.setHost} className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto" />;
};

/** Owns the OS subscription, pending timer and dismissal for the entire window, across Set up and Settings. */
export const CredentialNoticeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const view = useMemo(() => ({ host, setHost }), [host]);
  return <CredentialHostContext value={view}>{children}<CredentialNotice /></CredentialHostContext>;
};

const CredentialNotice = () => {
  const view = use(CredentialHostContext);
  const settings = useSettingsNoticeHost();
  const secrets = useShell()?.secrets;
  const { leave } = useChecklist();
  const clock = useClock();
  const [access, setAccess] = useState<SecretAccess>(null);
  const [dismissed, setDismissed] = useState<SecretAccess>(null);
  useEffect(() => {
    let timer: ReturnType<typeof clock.setTimeout> | undefined;
    const stop = secrets?.onAccess?.((state) => {
      timer?.cancel();
      setAccess(state === "waiting" ? null : state);
      if (state === "waiting") timer = clock.setTimeout(() => setAccess("waiting"), KEYCHAIN_NOTICE_DELAY_MS);
      else if (state === null) setDismissed(null);
    });
    return () => { timer?.cancel(); stop?.(); };
  }, [clock, secrets]);
  const hidden = access === null || dismissed === "denied" || dismissed === access;
  const host = settings?.host ?? view?.host;
  if (hidden || !host) return null;
  return createPortal(
    <section aria-label="Credential access" className="mb-[7px] min-w-0">
      <ul className="flex min-w-0 flex-col gap-1.5">
        <li className="relative flex min-w-0 items-start gap-2 rounded-[8px] border border-amber/45 bg-amber/10 px-3 py-2 pr-9 text-ink">
          <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-amber" />
          <div role="status" className="min-w-0 flex-1 font-mono text-2xs [overflow-wrap:anywhere]">
            <p>{access === "waiting" ? "Waiting for macOS Keychain access" : "Keychain access did not complete"}</p>
            <p className="mt-1 text-ink-muted">{access === "waiting"
              ? "macOS is asking for access to the stored credentials. Answering the macOS prompt keeps them. You can keep using this window while it waits."
              : "Stored credentials from the previous build could not be read. New credentials use a fresh OS-protected item; this machine's local environment keeps working. Pair again with the environments that were paired."}</p>
          </div>
          {access === "denied" && <Button variant="outline" size="xs" onClick={() => leave("environments.machines")}><ArrowRight aria-hidden="true" />Pair again</Button>}
          <IconButton label="Dismiss" keys="Enter / Space" size="icon-xs" className="absolute top-1 right-1" onClick={() => setDismissed(access)}><X aria-hidden="true" /></IconButton>
        </li>
      </ul>
    </section>, host);
};
