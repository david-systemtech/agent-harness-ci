import type { PlainRefusal } from "@agent-harness/client-runtime";
import { ArrowUpRight, Link, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { cloneElement, useId, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { CopyLine } from "../settings/copy-line.js";
import { useSettings } from "../settings/settings-window.js";
import { useChecklist } from "../setup/checklist-window.js";
import { Button, Field, RadioGroup, RadioGroupItem, Tooltip, type ButtonProps } from "../ui/index.js";

export type BankMode = "personal" | "join" | "team";
/** setup-copy.md §5.8's question and its three choices, the own notebook pre-selected. */
const kinds = [
  { value: "personal", label: "Create my own notebook", icon: UserRound },
  { value: "join", label: "Join my team's notebook", icon: Link },
  { value: "team", label: "Create a notebook for my team", icon: UsersRound },
] as const;

/** look.md §12.2: the question, then its choice rows with the selected wash and keyboard hints. */
export const BankChoices = ({ value, choose }: { readonly value: BankMode; readonly choose: (value: BankMode) => void }) => {
  const id = useId();
  return <div className="flex flex-col gap-1.5">
    <p id={id} className="text-sm font-medium text-ink">What would you like?</p>
    <RadioGroup data-bank-choices aria-labelledby={id} value={value} onValueChange={(next) => { if (next === "personal" || next === "team" || next === "join") choose(next); }} className="gap-0.5 rounded-lg border border-hairline bg-panel p-1.5">
      {kinds.map(({ value: kind, label, icon: Icon }) => <label key={kind} className={`flex items-center gap-2.5 rounded-md px-2.5 py-2 hover:bg-wash ${value === kind ? "bg-wash-strong" : ""}`}>
        <Tooltip content={label} keys="Arrow keys, Space"><RadioGroupItem value={kind} aria-label={label} /></Tooltip>
        <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        <span className="text-xs text-ink">{label}</span>
      </label>)}
    </RadioGroup>
  </div>;
};

/** A bank action named by what it does; when it cannot be used, why is visible text beside it (setup-copy.md §1 rule 16). */
export const BankButton = ({ label, icon: Icon, reason, children, ...props }: ButtonProps & { readonly label: string; readonly icon: LucideIcon; readonly reason?: string | undefined }) => {
  const id = useId();
  return <span className="inline-flex flex-wrap items-center gap-2">
    <Tooltip content={label} keys="Tab, Enter or Space">
      <span className="inline-flex" tabIndex={reason === undefined ? undefined : 0}>
        <Button {...props} aria-describedby={reason === undefined ? undefined : id} disabled={props.disabled || reason !== undefined}><Icon aria-hidden="true" />{children ?? label}</Button>
      </span>
    </Tooltip>
    {reason !== undefined && <span id={id} className="text-2xs text-ink-muted">{reason}</span>}
  </span>;
};

/** A field with its hint and, after a press that found it empty, its error beside it: text and colour, an alert read with "Error: " first. */
export const BankField = ({ label, icon: Icon, children, wide = false, hint, error }: { readonly label: string; readonly icon: LucideIcon; readonly children: ReactElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>; readonly wide?: boolean; readonly hint?: string; readonly error?: string | undefined }) => {
  const errorId = useId();
  const control = error === undefined ? children : cloneElement(children, { "aria-describedby": errorId, "aria-invalid": true });
  return <div data-bank-field className={wide ? "max-w-[320px]" : "max-w-[224px]"}>
    <div className="flex items-start gap-2"><Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-muted" /><Tooltip content={label} keys="Tab to focus, type to edit"><div className="min-w-0 flex-1"><Field label={label} {...(hint !== undefined && { description: hint })}>{control}</Field></div></Tooltip></div>
    {error !== undefined && <p id={errorId} role="alert" tabIndex={-1} className="mt-1 pl-6 text-sm text-signal"><span className="sr-only">Error: </span>{error}</p>}
  </div>;
};

/** `Enter {field}.` for each field a press found empty (setup-copy.md §5.8), by the field's name. */
const empties = <Field extends string>(fields: Readonly<Record<Field, readonly [value: string, words: string]>>): Partial<Record<Field, string>> =>
  Object.fromEntries(Object.entries<readonly [string, string]>(fields).filter(([, [value]]) => value.trim() === "").map(([field, [, words]]) => [field, `Enter ${words}.`])) as Partial<Record<Field, string>>;

/** A press with an empty field says so beside it and sends nothing; one with every field filled sends. */
export const useFieldCheck = <Field extends string>() => {
  const form = useRef<HTMLDivElement>(null);
  const [missing, setMissing] = useState<Partial<Record<Field, string>>>({});
  // Wait for every field error, including choice errors, to render before focusing in form order.
  useLayoutEffect(() => {
    const control = form.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (control == null) return;
    control.focus();
    if (control.ownerDocument.activeElement !== control) control.closest("[data-bank-field]")?.querySelector<HTMLElement>('[role="alert"]')?.focus();
  }, [missing]);
  const press = (fields: Readonly<Record<Field, readonly [string, string]>>, send: () => void) => {
    const found = empties(fields);
    setMissing(found);
    if (Object.keys(found).length === 0) send();
  };
  return { missing, press, form };
};

/** A refusal's plain line, never cut, its raw facts under Details with Copy details (setup-copy.md §3). */
export const BankRefusal = ({ refusal }: { readonly refusal: PlainRefusal }) => <div className="flex min-w-0 flex-col gap-1">
  <p role="alert" className="text-sm text-signal"><span className="sr-only">Error: </span>{refusal.line}</p>
  {refusal.details.length > 0 && <CopyLine label="Details" text={refusal.details.join("\n")} copyLabel="Copy details" />}
</div>;

/** Go to Forges: inside Set up the Forges step (setup-copy.md §3, cross-step fixes stay inside Set up); in Settings, its Forges row on this computer. */
export const GoToForges = ({ environmentId }: { readonly environmentId: string }) => {
  const checklist = useChecklist();
  const settings = useSettings();
  return <BankButton label="Go to Forges" icon={ArrowUpRight} variant="outline" onClick={() => checklist.shown ? checklist.choose("forges") : settings.open("access.forges", environmentId)} />;
};
