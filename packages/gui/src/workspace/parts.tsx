import { Folder } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "../ui/tooltip.js";

/** The workspace picker's title retains its full wording at enlarged text sizes. */
export const ViewTitle = ({ children }: { readonly children: ReactNode }) => <h2 className="break-words text-sm font-medium text-ink">{children}</h2>;

/** Directory and branch choices expose their path and refusal through the same focusable hint. */
export const Entry = (props: { readonly name: string; readonly detail?: string | undefined; readonly absent?: string | undefined; readonly disabled?: boolean; choose?(): void }) => {
  const off = props.absent !== undefined || props.disabled === true || props.choose === undefined;
  const label = [props.name, props.detail, props.absent].filter(Boolean).join(" · ");
  const action = <button type="button" disabled={off} onClick={props.choose} className="flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-1 text-left text-sm text-ink outline-none hover:bg-raised focus-visible:outline-2 focus-visible:outline-beam disabled:opacity-50">
    <Folder aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
    <span className="min-w-0 break-words font-mono">{props.name}{props.detail !== undefined && <span className="text-xs text-ink-faint"> {props.detail}</span>}{props.absent !== undefined && <span className="block text-xs text-ink-faint">{props.absent}</span>}</span>
  </button>;
  return <li><Tooltip content={label} keys="Enter / Space">{off ? <span role="group" tabIndex={0} aria-label={label} className="block">{action}</span> : action}</Tooltip></li>;
};

export const PickerLine = ({ line }: { readonly line: string | undefined }) => line === undefined ? null : <p role="status" className="text-xs text-ink-muted">{line}</p>;
