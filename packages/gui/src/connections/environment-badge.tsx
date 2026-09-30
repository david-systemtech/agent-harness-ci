import type { EnvironmentView } from "@agent-harness/client-runtime";
import { environmentColour } from "../theme/paint.js";
import { THIS_MACHINE } from "./words.js";

/**
 * An environment's badge (ADR 0005; docs/specs/gui.md, "The window and the
 * sidebar"): its icon in its colour's token (ADR 0023: the colour is a name,
 * drawn with the theme's token for it), which the sidebar's rows and
 * headings, the header and the status line wear. The environment names its
 * icon (#323: `laptop`, `server`), and the window draws none of the ten yet
 * (#675), so the icon is a dot in the colour, the accent's cyan while the
 * environment has said no colour.
 */
export const EnvironmentDot = ({ view, label }: { readonly view: EnvironmentView | undefined; readonly label?: string }) => {
  const colour = environmentColour(view?.colour ?? null);
  return (
    <span
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      style={colour === undefined ? undefined : { color: colour }}
      className={colour === undefined ? "size-2 shrink-0 rounded-full bg-current text-cyan" : "size-2 shrink-0 rounded-full bg-current"}
    />
  );
};

/** The badge, then the environment's name: "This machine" for the local environment before it has answered. */
export const EnvironmentBadge = ({ view }: { readonly view: EnvironmentView | undefined }) => (
  <span className="flex shrink-0 items-center gap-1 pr-1 font-medium text-ink">
    <EnvironmentDot view={view} />
    <span>{view?.name ?? THIS_MACHINE}</span>
  </span>
);
