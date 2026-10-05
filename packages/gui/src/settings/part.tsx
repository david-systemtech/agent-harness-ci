import { useId, type ReactNode } from "react";
import { RadioGroup, RadioGroupItem, Tooltip } from "../ui/index.js";
import "./settings-layout.css";
import { classes } from "../ui/classes.js";

/** The bounded pane's content stack and title, with scope controls beside it. */
export const SettingsPane = ({ title, actions, pinned, children }: { readonly title: string; readonly actions?: ReactNode; readonly pinned?: ReactNode; readonly children: ReactNode }) => (
  <div data-settings-pane className="mx-auto flex min-w-0 w-full flex-col gap-3.5 px-6 py-5">
    <header className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold leading-tight text-ink">{title}</h2>
      {pinned}
      {actions}
    </header>
    {children}
  </div>
);

/** Card collections fill the pane and choose columns from the space available. */
export const SettingsCardGrid = ({ children }: { readonly children: ReactNode }) => <div data-settings-card-grid>{children}</div>;

/** A named group with an optional header and divided body rows (look.md §12.2). */
export const SettingsGroup = ({ title, children }: { readonly title?: string; readonly children: ReactNode }) => {
  const heading = useId();
  return (
    <section aria-labelledby={title === undefined ? undefined : heading} className="overflow-hidden rounded-lg border border-hairline">
      {title !== undefined && <h3 id={heading} className="border-b border-hairline px-3 py-2 text-xs font-medium text-ink">{title}</h3>}
      <div className="divide-y divide-hairline [&>*]:p-3">{children}</div>
    </section>
  );
};

/** Existing pane sections share the measured settings group. */
export const Part = ({ title, children }: { readonly title: string; readonly children: ReactNode }) => <SettingsGroup title={title}>{children}</SettingsGroup>;

export interface SettingsChoice {
  readonly value: string;
  readonly label: string;
  readonly note: string;
  readonly disabledReason?: string;
}

/** Described radio choices; callers own their value and any write or confirmation. */
export const ChoiceList = ({ label, value, choices, onValueChange }: { readonly label: string; readonly value: string; readonly choices: readonly SettingsChoice[]; readonly onValueChange: (value: string) => void }) => {
  const id = useId();
  return <RadioGroup aria-label={label} value={value} onValueChange={onValueChange} className="gap-0.5 p-1.5">
    {choices.map((choice, index) => <label key={choice.value} className={classes("flex items-start gap-2.5 rounded-md px-2.5 py-2", choice.value === value && "bg-wash-strong", choice.disabledReason === undefined ? "hover:bg-wash" : "opacity-50")}>
      <Tooltip content={`${choice.label} · Arrow keys${choice.disabledReason === undefined ? "" : ` · ${choice.disabledReason}`}`}><RadioGroupItem value={choice.value} aria-label={choice.label} aria-describedby={`${id}-${index}`} disabled={choice.disabledReason !== undefined} className="mt-[3px]" /></Tooltip>
      <span className="flex min-w-0 flex-col"><span className="text-xs text-ink">{choice.label}</span><span id={`${id}-${index}`} className="text-2xs text-ink-faint">{choice.note}{choice.disabledReason !== undefined && <span className="block">{choice.disabledReason}</span>}</span></span>
    </label>)}
  </RadioGroup>;
};
