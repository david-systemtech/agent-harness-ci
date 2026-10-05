import type { BrowserRow } from "@agent-harness/client-runtime";
import type { SessionBrowser } from "@agent-harness/contracts";
import { Check, Globe } from "lucide-react";
import { useState } from "react";
import { Button, Menu, MenuItem, Tooltip } from "../ui/index.js";
import { RunPickerContent, RunPickerTrigger } from "../status/run-picker-parts.js";
import { classes } from "../ui/classes.js";
import { MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/menu.js";
import { useFirstKey, useWindowAction, type Offer } from "../keys/key-dispatch.js";

/** Both browser chips draw the runtime's picker copy and refusals. */
export const BrowserChoiceMenu = ({ rows, choose, className, detail, sheet = false, offer = { status: "present" } }: {
  readonly rows: readonly BrowserRow[];
  readonly choose: (value: SessionBrowser | null) => void;
  readonly className?: string;
  readonly detail?: string | undefined;
  readonly sheet?: boolean;
  readonly offer?: Offer;
}) => {
  const keys = useFirstKey("app.browser.choose");
  const [open, setOpen] = useState(false);
  const chosen = rows.find((row) => row.selected)?.label ?? "Default";
  useWindowAction("app.browser.choose", () => setOpen(true), offer);
  const disabled = offer.status === "absent" || rows.length === 0;
  const trigger = <RunPickerTrigger sheet={sheet} openSheet={() => setOpen(true)}>
    <Button aria-label={`Browser: ${chosen}`} className={className} disabled={disabled}>
      <Globe aria-hidden="true" /> <span className="truncate">{chosen}</span>
    </Button>
  </RunPickerTrigger>;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip content={[`Browser: ${chosen}`, keys ?? "Enter to open", detail, rows.find((row) => row.selected)?.unavailable?.message, offer.status === "absent" ? offer.message : undefined].filter(Boolean).join(" · ")}>
        {disabled ? <span tabIndex={0} className="inline-flex" aria-label={offer.status === "absent" ? offer.message : "Browser choices are loading."}>{trigger}</span> : trigger}
      </Tooltip>
      <RunPickerContent sheet={sheet} side="top" align="start" role={sheet ? "dialog" : "menu"} aria-label={sheet ? "Browser choices" : undefined} {...(sheet ? { "aria-labelledby": undefined } : {})} className="w-72 max-h-[320px] overflow-y-auto">
        <BrowserChoiceRows rows={rows} choose={choose} />
      </RunPickerContent>
    </Menu>
  );
};

const BrowserChoiceRows = ({ rows, choose }: { readonly rows: readonly BrowserRow[]; readonly choose: (value: SessionBrowser | null) => void }) => <>
  {rows.map((row) => <MenuItem key={JSON.stringify(row.value)} title={`${row.label} · Enter to choose · ↑ ↓ Home End${row.unavailable === null ? "" : ` · ${row.unavailable.message}`}`} className={classes("items-start gap-2 px-2.5 py-2 text-xs", row.selected && "bg-wash")} disabled={row.unavailable !== null} onSelect={() => choose(row.value)}>
      <Globe aria-hidden="true" className="mt-0.5 size-3" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="block font-medium">{row.label}{row.selected && " · the chip's now"}</span>
        <span className="block text-2xs text-ink-muted">{row.note}</span>
        {row.unavailable !== null && <span className="block text-2xs text-ink-muted">{row.unavailable.message}</span>}
      </span>
      {row.selected && <Check aria-hidden="true" className="mt-0.5 size-3" />}
    </MenuItem>)}
</>;

/** The run popup uses the same rows and refusal rules as the browser chip. */
export const BrowserChoiceSubmenu = ({ rows, choose, offer }: { readonly rows: readonly BrowserRow[]; readonly choose: (value: SessionBrowser | null) => void; readonly offer: Offer }) => <MenuSub>
  <MenuSubTrigger title={`Browser · Right arrow to open${offer.status === "absent" ? ` · ${offer.message}` : ""}`} disabled={offer.status === "absent" || rows.length === 0}><Globe aria-hidden="true" />Browser</MenuSubTrigger>
  <MenuSubContent aria-label="Browser" className="w-72 max-h-[320px] overflow-y-auto"><BrowserChoiceRows rows={rows} choose={choose} /></MenuSubContent>
</MenuSub>;
