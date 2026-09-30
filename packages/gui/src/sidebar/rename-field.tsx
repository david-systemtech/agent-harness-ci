import { useRef } from "react";
import { Input } from "../ui/index.js";

export interface RenameFieldProps {
  /** What names the field. */
  readonly label: string;
  /** The name as it is. */
  readonly value: string;
  readonly maxLength: number;
  /** Renames to `name`, trimmed: called only for one that is not blank and not the name as it is. */
  commit(name: string): void;
  /** Puts the name back in place of the field. */
  close(): void;
}

/**
 * A name renamed in place (docs/specs/gui.md, "The window and the sidebar"):
 * a field holding the name, selected; Enter, or leaving the field, renames
 * it; Esc keeps it as it was. A blank name, or the same one, renames
 * nothing.
 */
export const RenameField = ({ label, value, maxLength, commit, close }: RenameFieldProps) => {
  const done = useRef(false);
  const finish = (typed: string | null) => {
    if (done.current) return;
    done.current = true;
    close();
    const name = typed?.trim() ?? "";
    if (name !== "" && name !== value) commit(name);
  };
  return (
    <Input
      aria-label={label}
      defaultValue={value}
      maxLength={maxLength}
      autoFocus
      className="h-7"
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => finish(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
};
