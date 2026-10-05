import { Dialog as RadixDialog } from "radix-ui";
import { matchSettingsRows } from "@agent-harness/client-runtime";
import { useState } from "react";
import { X } from "lucide-react";
import { useIsKeyOf, useFirstKey } from "../keys/key-dispatch.js";
import { Button } from "../ui/index.js";
import { DIALOG_SCRIM } from "../ui/dialog.js";
import { SettingsRail } from "./rail.js";
import { RowPane } from "./row-pane.js";
import { PhoneNavigation, usePhoneSettings } from "./phone-navigation.js";
import { useSettings, useSettingsNoticeHost } from "./settings-window.js";

/** Settings overlays the mounted session window, bounded by look.md §12.1. */
export const SettingsView = () => {
  const phone = usePhoneSettings();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { row, close } = useSettings();
  const noticeHost = useSettingsNoticeHost();
  const isToggle = useIsKeyOf("app.settings.toggle");
  const toggleKey = useFirstKey("app.settings.toggle");
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) close(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={DIALOG_SCRIM} />
        <RadixDialog.Content
          data-settings-dialog
          className="fixed sm:left-1/2 sm:top-1/2 z-50 flex h-[min(660px,calc(100dvh-3rem))] w-[min(1000px,calc(100vw-3rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 flex-col overflow-hidden rounded-xl bg-float text-ink ring-1 ring-ink/10 outline-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (phone) { document.querySelector<HTMLButtonElement>(".phone-navigation-trigger")?.focus(); return; }
            document.querySelector<HTMLInputElement>('[data-settings-dialog] input[type="search"]')?.focus();
          }}
          onEscapeKeyDown={(event) => {
            // Local editors and key recorders handle Escape before this dialog dismisses.
            if (event.target instanceof Element && event.target.closest("[data-recording], [data-local-escape]")) event.preventDefault();
            if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (!event.defaultPrevented && isToggle(event.nativeEvent)) { event.preventDefault(); close(); }
            event.stopPropagation();
          }}
        >
          <section aria-label="Settings" className="flex min-h-0 flex-1 flex-col">
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-hairline px-4 py-3">
              <div className="min-w-0">
                <RadixDialog.Title className="text-sm font-semibold">Settings</RadixDialog.Title>
                <RadixDialog.Description className="mt-0.5 text-2xs text-ink-muted">Changes apply to future runs. Appearance changes apply immediately.</RadixDialog.Description>
              </div>
              <Button title={`Close Settings · Escape${toggleKey === undefined ? "" : ` · ${toggleKey}`}`} aria-label="Close Settings" size="icon-xs" onClick={close}><X aria-hidden="true" /></Button>
            </header>
            <div data-settings-notices ref={noticeHost?.setHost} className="max-h-[40%] min-h-0 shrink-0 overflow-y-auto px-4" />
            <div data-settings-body className="flex min-h-0 flex-1">
              {phone ? <PhoneNavigation title="Settings rows" open={navigationOpen} onOpenChange={setNavigationOpen}>
                <SettingsRail current={row} query={query} setQuery={setQuery} onChoose={() => { setNavigationOpen(false); setQuery(""); }} />
              </PhoneNavigation> : <SettingsRail current={row} query={query} setQuery={setQuery} />}
              <RowPane key={row} row={row} filtered={!matchSettingsRows(query).includes(row)} clearSearch={() => setQuery("")} />
            </div>
          </section>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
};
