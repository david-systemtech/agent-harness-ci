import { Link, UserRound, UsersRound, type LucideIcon } from "lucide-react";
import { useId, type ReactElement } from "react";
import { Button, Field, RadioGroup, RadioGroupItem, Tooltip, type ButtonProps } from "../ui/index.js";

export type BankMode = "personal" | "team" | "join";
const kinds = [
  { value: "personal", label: "Personal", note: "Create a notebook for your own work.", icon: UserRound },
  { value: "team", label: "Team", note: "Create a shared notebook on a verified forge.", icon: UsersRound },
  { value: "join", label: "Join a bank", note: "Preview a bank link and choose which accounts use it.", icon: Link },
] as const;

/** look.md §12.2: described choice rows, with the selected wash and keyboard hints. */
export const BankChoices = ({ value, choose }: { readonly value: BankMode; readonly choose: (value: BankMode) => void }) => {
  const id = useId();
  return <RadioGroup data-bank-choices aria-label="Bank kind" value={value} onValueChange={(next) => { if (next === "personal" || next === "team" || next === "join") choose(next); }} className="gap-0.5 rounded-lg border border-hairline bg-panel p-1.5">
  {kinds.map(({ value: kind, label, note, icon: Icon }) => <label key={kind} className={`flex items-start gap-2.5 rounded-md px-2.5 py-2 hover:bg-wash ${value === kind ? "bg-wash-strong" : ""}`}>
    <Tooltip content={label} keys="Arrow keys, Space"><RadioGroupItem value={kind} aria-label={label} aria-describedby={`${id}-${kind}`} className="mt-[3px]" /></Tooltip>
    <Icon aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-ink-muted" />
    <span className="flex min-w-0 flex-col"><span className="text-xs text-ink">{label}</span><span id={`${id}-${kind}`} className="text-2xs text-ink-faint">{note}</span></span>
  </label>)}
</RadioGroup>;
};

/** Every bank action names its keys and, when unavailable, the reason. */
export const BankButton = ({ label, icon: Icon, reason, children, ...props }: ButtonProps & { readonly label: string; readonly icon: LucideIcon; readonly reason?: string | undefined }) => <Tooltip content={[label, reason].filter(Boolean).join(" · ")} keys="Tab, Enter or Space">
  <span className="inline-flex" tabIndex={reason === undefined ? undefined : 0}>
    <Button {...props} title={[label, "Tab, Enter or Space", reason].filter(Boolean).join(" · ")} disabled={props.disabled || reason !== undefined}><Icon aria-hidden="true" />{children ?? label}</Button>
  </span>
</Tooltip>;

/** Field icons are decoration; the human label remains the accessible name. */
export const BankField = ({ label, icon: Icon, children, wide = false }: { readonly label: string; readonly icon: LucideIcon; readonly children: ReactElement; readonly wide?: boolean }) => <div data-bank-field className={wide ? "max-w-[320px]" : "max-w-[224px]"}>
  <div className="flex items-start gap-2"><Icon aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-muted" /><Tooltip content={label} keys="Tab to focus, type to edit"><div className="min-w-0 flex-1"><Field label={label}>{children}</Field></div></Tooltip></div>
</div>;
