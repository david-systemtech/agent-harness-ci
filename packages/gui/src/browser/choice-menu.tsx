import type { BrowserRow } from "@agent-harness/client-runtime";
import type { SessionBrowser } from "@agent-harness/contracts";
import { useState } from "react";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from "../ui/index.js";
import { useWindowAction, type Offer } from "../keys/key-dispatch.js";

/** Both browser chips draw the runtime's picker copy and refusals. */
export const BrowserChoiceMenu = ({ rows, choose, className, offer = { status: "present" } }: {
  readonly rows: readonly BrowserRow[];
  readonly choose: (value: SessionBrowser | null) => void;
  readonly className?: string;
  readonly offer?: Offer;
}) => {
  const [open, setOpen] = useState(false);
  const chosen = rows.find((row) => row.selected)?.label ?? "Default";
  useWindowAction("app.browser.choose", () => setOpen(true), offer);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>
        <Button aria-label={`Browser: ${chosen}`} className={className} disabled={offer.status === "absent" || rows.length === 0} title={offer.status === "absent" ? offer.message : undefined}>
          <span className="text-ink-faint">Browser</span> <span className="truncate">{chosen}</span>
        </Button>
      </MenuTrigger>
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
