import { ArrowLeft, ArrowRight, Check, Cpu } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent, type ReactNode } from "react";
import { classes } from "../ui/classes.js";
import { Button, MenuItem, MenuLabel } from "../ui/index.js";

/** Rows keep the popup open while a dependent choice is made. */
export const RunChoiceRow = ({ label, note, under, selected, dim, primary, machine, icon: Icon, onSelect }: {
  readonly label: string; readonly primary?: string; readonly machine?: string | undefined; readonly note?: string | undefined; readonly under?: string | undefined;
  readonly selected?: boolean; readonly dim?: boolean; readonly icon: typeof Cpu; readonly onSelect: () => void;
}) => <MenuItem title={`${label} · Enter to choose · ↑ ↓ Home End · Tab next column${note ? ` · ${note}` : ""}`} aria-label={label} aria-disabled={dim || undefined} data-selected={selected || undefined} onSelect={(event) => { event.preventDefault(); onSelect(); }}
    className={classes("items-start gap-2 px-2.5 py-2 text-xs [overflow-wrap:anywhere] [&_svg]:size-3", selected && "bg-wash", dim && "opacity-50")}>
    <Icon aria-hidden="true" className="mt-0.5 size-3" />
    <span className="min-w-0 flex-1">
      <span className="block font-medium">{primary ?? label}</span>
      {machine !== undefined && <span className="block font-mono text-2xs text-ink-muted">{machine}</span>}
      {note !== undefined && <span className="block text-2xs text-ink-muted">{note}</span>}
      {under !== undefined && <span className="block text-2xs text-ink-muted">{under}</span>}
    </span>
    {selected && <Check aria-hidden="true" className="mt-0.5 size-3" />}
  </MenuItem>;

const subscribeWidth = (changed: () => void) => {
  window.addEventListener("resize", changed);
  return () => window.removeEventListener("resize", changed);
};

/** Arrows stay in a list; Tab moves to the next dependency, rather than closing a menu. */
export const moveInColumns = (event: KeyboardEvent<HTMLDivElement>) => {
  const target = event.target as HTMLElement;
  if (target.tagName === "INPUT") {
    if (!["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key)) event.stopPropagation();
    if (!["Tab", "ArrowDown", "ArrowUp"].includes(event.key)) return;
  }
  const column = target.closest<HTMLElement>("[data-run-column]");
  if (column === null) return;
  const rows = [...column.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled]), button')];
  let next: HTMLElement | undefined;
  if (event.key === "Tab") {
    const columns = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-run-column]")].filter((entry) => !entry.hidden);
    const index = columns.indexOf(column);
    const destination = columns[(index + (event.shiftKey ? columns.length - 1 : 1)) % columns.length];
    next = destination?.querySelector<HTMLElement>('input, button, [role="menuitem"]:not([data-disabled])') ?? undefined;
  } else if (event.key === "Home") next = rows[0];
  else if (event.key === "End") next = rows.at(-1);
  else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const index = rows.indexOf(target.closest<HTMLElement>('[role="menuitem"], button') ?? target);
    next = rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
  }
  if (next !== undefined) { event.preventDefault(); event.stopPropagation(); next.focus(); }
};

/** Shared responsive boundary for the run picker and settings' narrower body. */
export const useNarrowRunPicker = (breakpoint = 800) => useSyncExternalStore(subscribeWidth, () => window.innerWidth < breakpoint);

export type RunStage = "Accounts" | "Models" | "Effort";

/** A dependency column shared by session choices and standing defaults. */
export const RunPickerColumn = ({ name, narrow, activeColumn, showEffortWithModel = true, children }: {
  readonly name: RunStage; readonly narrow: boolean; readonly activeColumn: RunStage; readonly showEffortWithModel?: boolean; readonly children: ReactNode;
}) => <div role="group" aria-label={name} data-run-column={name}
    hidden={narrow && activeColumn !== name && !(showEffortWithModel && activeColumn === "Models" && name === "Effort")}
    className={classes("min-w-0 shrink-0", narrow ? "w-full" : name === "Accounts" ? "w-56" : "w-64")}>
    <MenuLabel className="px-4 py-2">{name}</MenuLabel>
    <div data-run-list className="max-h-[320px] overflow-y-auto p-1.5">{children}</div>
  </div>;

/** One dependency at a time, with focus following the visible list after a step changes. */
export const RunPickerSteps = ({ stage, effort, change }: {
  readonly stage: RunStage; readonly effort: boolean; readonly change: (stage: RunStage) => void;
}) => {
  const steps = useRef<HTMLDivElement>(null);
  const previous = useRef(stage);
  useEffect(() => {
    if (previous.current === stage) return;
    previous.current = stage;
    steps.current?.parentElement?.querySelector<HTMLElement>(`[data-run-column="${stage}"] input, [data-run-column="${stage}"] [role="menuitem"]:not([data-disabled])`)?.focus();
  }, [stage]);
  const back = stage === "Effort" ? "Models" : "Accounts";
  const next = stage === "Accounts" ? "Models" : stage === "Models" && effort ? "Effort" : undefined;
  return <div ref={steps} role="group" aria-label="Steps" data-run-column="Steps" className="flex min-w-0 items-center justify-between gap-2 border-b border-hairline p-1.5">
    {stage !== "Accounts" && <Button aria-label={`Back: ${back}`} onClick={() => change(back)}><ArrowLeft aria-hidden="true" />Back</Button>}
    <span className="text-xs text-ink-muted">{stage}</span>
    {next !== undefined && <Button aria-label={`Next: ${next}`} onClick={() => change(next)}>Next<ArrowRight aria-hidden="true" /></Button>}
  </div>;
};
