import { desktopPicker, type DesktopRow, type SessionProjection } from "@agent-harness/client-runtime";
import type { SessionDesktop } from "@agent-harness/contracts";
import { Check, Monitor } from "lucide-react";
import { useMemo, useState } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { Button, Menu, MenuContent, MenuItem, MenuTrigger, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { MenuSub, MenuSubContent, MenuSubTrigger } from "../ui/menu.js";
import { useObservableSelector, useRuntime } from "../window-context.js";

/** The session field changes through its command; a running desktop remains the run's resolution (#2161). */
const desktopFields = (projection: SessionProjection) => ({ desktop: projection.summary?.desktop, runs: projection.runs, desktopResolutions: projection.desktopResolutions });

const DesktopChoiceRows = ({ rows, choose }: { readonly rows: readonly DesktopRow[]; readonly choose: (value: SessionDesktop) => void }) => <>
  {rows.map((row) => <MenuItem key={row.value.kind} title={`${row.label} · Enter to choose · ↑ ↓ Home End`} className={classes("items-start gap-2 px-2.5 py-2 text-xs", row.selected && "bg-wash")} onSelect={() => choose(row.value)}>
      <Monitor aria-hidden="true" className="mt-0.5 size-3" />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="block font-medium">{row.label}{row.selected && " · the chip's now"}</span>
        <span className="block text-2xs text-ink-muted">{row.note}</span>
      </span>
      {row.selected && <Check aria-hidden="true" className="mt-0.5 size-3" />}
    </MenuItem>)}
</>;

/** The desktop chip beside the browser's, and its submenu in the run popup: the session's desktop for the next run, and why this run has none when it asked for one. */
export const SessionDesktopPicker = ({ environmentId, sessionId, submenu = false }: { readonly environmentId: string; readonly sessionId: string; readonly submenu?: boolean }) => {
  const runtime = useRuntime();
  const session = useObservableSelector(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]), desktopFields);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [, say] = usePaneLine();
  const capability = runtime.capability(environmentId, "sessions.setDesktop");
  const run = session.runs.at(-1);
  const picker = desktopPicker(session.desktop, run === undefined ? undefined : session.desktopResolutions[run.runId]);
  const choose = async (desktop: SessionDesktop) => {
    setBusy(true);
    const answer = await runtime.commands.dispatch(environmentId, "sessions.setDesktop", { sessionId, desktop });
    const label = picker.rows.find((row) => row.value.kind === desktop.kind)?.label ?? desktop.kind;
    say(answer.ok ? `Desktop set to ${label} for the next run.` : `Desktop not changed: ${answer.error.message}`);
    setBusy(false);
  };
  const offer: Offer = busy ? { status: "absent", message: "Changing the desktop." } : capability;
  const disabled = offer.status === "absent";
  const absent = offer.status === "absent" ? offer.message : undefined;
  if (submenu) return <MenuSub>
    <MenuSubTrigger title={`Desktop · Right arrow to open${absent === undefined ? "" : ` · ${absent}`}`} disabled={disabled}><Monitor aria-hidden="true" />Desktop</MenuSubTrigger>
    <MenuSubContent aria-label="Desktop" className="w-72 max-h-[320px] overflow-y-auto"><DesktopChoiceRows rows={picker.rows} choose={(desktop) => void choose(desktop)} /></MenuSubContent>
  </MenuSub>;
  const chosen = picker.rows.find((row) => row.selected)?.label ?? "No desktop";
  const detail = picker.refused === null ? undefined : `${run?.state === "running" ? "This run" : "Last run"}: no desktop. ${picker.refused.message}`;
  const trigger = <MenuTrigger asChild>
    <Button aria-label={`Desktop: ${chosen}`} className="h-[22px] max-w-[240px] min-w-0 gap-1 rounded-md bg-wash px-1.5 text-2xs font-normal hover:bg-wash-strong aria-expanded:bg-wash-strong [&_svg]:size-3" disabled={disabled}>
      <Monitor aria-hidden="true" /> <span className="truncate">{chosen}</span>
    </Button>
  </MenuTrigger>;
  return <div className="contents">
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip keys="Enter to open" content={[`Desktop: ${chosen}`, detail, absent].filter(Boolean).join(" · ")}>
        {disabled ? <span tabIndex={0} className="inline-flex" aria-label={absent}>{trigger}</span> : trigger}
      </Tooltip>
      <MenuContent side="top" align="start" className="w-72 max-h-[320px] overflow-y-auto">
        <DesktopChoiceRows rows={picker.rows} choose={(desktop) => void choose(desktop)} />
      </MenuContent>
    </Menu>
    {detail !== undefined && <span className="sr-only">{detail}</span>}
  </div>;
};
