import type { ReactNode } from "react";

/**
 * What every view of the workspace picker is drawn from (#421): its title,
 * an entry of a list (a directory, a branch) with what it says under or
 * beside it, and the picker's one line.
 */

/** A view's title: what it asks for, on which environment. */
export const ViewTitle = ({ children }: { readonly children: ReactNode }) => <h2 className="truncate text-xs font-medium text-ink-muted">{children}</h2>;

/** One entry of a list: its name, then what it says beside it; dim with why under it while it cannot be chosen. */
export const Entry = (props: { readonly name: string; readonly detail?: string | undefined; readonly absent?: string | undefined; readonly disabled?: boolean; choose?(): void }) => (
  <li>
    <button
      type="button"
      disabled={props.absent !== undefined || props.disabled === true || props.choose === undefined}
      onClick={props.choose}
      className="flex w-full min-w-0 flex-col rounded-sm px-2 py-1 text-left text-sm text-ink outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam disabled:text-ink-faint disabled:hover:bg-transparent"
    >
      <span className="truncate">
        {props.name}
        {props.detail !== undefined && <span className="text-xs text-ink-faint"> {props.detail}</span>}
      </span>
      {props.absent !== undefined && <span className="truncate text-xs text-ink-faint">{props.absent}</span>}
    </button>
  </li>
);

/** The picker's one line: what it waits for, or why what was chosen was not taken. */
export const PickerLine = ({ line }: { readonly line: string | undefined }) =>
  line === undefined ? null : (
    <p role="status" className="text-xs text-ink-muted">
      {line}
    </p>
  );
