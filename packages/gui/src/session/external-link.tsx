import type { ReactNode } from "react";
import { classes } from "../ui/classes.js";
import { useShell } from "../window-context.js";

/**
 * A link to a page outside the app: opened in the OS's browser through the
 * shell's `openExternal` on the desktop, whose window navigates nowhere
 * else; a link a browser tab opens in a tab of its own where there is no
 * shell.
 */
export const ExternalLink = ({
  url,
  label,
  look = "text-beam-text underline",
  children,
}: {
  readonly url: string;
  /** Its name, when its text is not. */
  readonly label?: string;
  /** Its colour and decoration: preset the accent's text, underlined. */
  readonly look?: string;
  readonly children: ReactNode;
}) => {
  const open = useShell()?.openExternal;
  const className = classes("break-all rounded-sm text-left outline-none focus-visible:outline-2 focus-visible:outline-beam", look);
  if (open === undefined) {
    return (
      <a href={url} target="_blank" rel="noreferrer" aria-label={label} title={url} className={className}>
        {children}
      </a>
    );
  }
  return (
    <button type="button" aria-label={label} title={url} className={className} onClick={() => void open(url)}>
      {children}
    </button>
  );
};
