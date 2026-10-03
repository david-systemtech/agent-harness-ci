import type { BrowserRow } from "@agent-harness/client-runtime";
import type { SessionBrowser } from "@agent-harness/contracts";
import { Globe } from "lucide-react";
import { useState } from "react";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "../ui/index.js";
import { useFirstKey, useWindowAction, type Offer } from "../keys/key-dispatch.js";

/** Both browser chips draw the runtime's picker copy and refusals. */
export const BrowserChoiceMenu = ({ rows, choose, className, detail, offer = { status: "present" } }: {
  readonly rows: readonly BrowserRow[];
  readonly choose: (value: SessionBrowser | null) => void;
  readonly className?: string;
  readonly detail?: string | undefined;
  readonly offer?: Offer;
}) => {
  const keys = useFirstKey("app.browser.choose");
  const [open, setOpen] = useState(false);
  const chosen = rows.find((row) => row.selected)?.label ?? "Default";
  useWindowAction("app.browser.choose", () => setOpen(true), offer);
  const disabled = offer.status === "absent" || rows.length === 0;
  const trigger = <MenuTrigger asChild>
    <Button aria-label={`Browser: ${chosen}`} className={className} disabled={disabled}>
      <Globe aria-hidden="true" /> <span className="truncate">{chosen}</span>
    </Button>
  </MenuTrigger>;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip content={[`Browser: ${chosen}`, keys ?? "Enter to open", detail, rows.find((row) => row.selected)?.unavailable?.message, offer.status === "absent" ? offer.message : undefined].filter(Boolean).join(" · ")}>
        {disabled ? <span tabIndex={0} className="inline-flex" aria-label={offer.status === "absent" ? offer.message : "Browser choices are loading."}>{trigger}</span> : trigger}
      </Tooltip>
      <MenuContent align="start" className="max-h-96 max-w-md overflow-y-auto">
        {rows.map((row, index) => (
          <MenuItem key={index} disabled={row.unavailable !== null} onSelect={() => choose(row.value)}>
            <span className="flex flex-col">
              <span>{row.label}{row.selected && " · the chip's now"}</span>
              <span className="text-xs text-ink-faint">{row.note}</span>
              {row.unavailable !== null && <span className="text-xs text-ink-faint">{row.unavailable.message}</span>}
            </span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
};
