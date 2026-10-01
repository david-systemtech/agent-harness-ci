import type { EnvironmentView } from "@agent-harness/client-runtime";
import { environmentColour } from "../theme/paint.js";
import { classes } from "../ui/classes.js";
import { glyphOf } from "./environment-glyphs.js";
import { THIS_MACHINE } from "./words.js";

/**
 * An environment's icon in its colour's token (ADR 0005; docs/specs/gui.md,
 * "The window and the sidebar"; ADR 0023: the colour is a name, drawn with
 * the theme's token for it, the accent's cyan while the environment has said
 * no colour), which every place that shows an environment wears (the
 * sidebar's rows and headings, the header, the caption, the status line, the
 * new-session chip, the Your machines cards), so the ten icons are drawn
 * here alone (#675). The icon is the window's glyph for the name the
 * environment gives, named for assistive technology by that name
 * ("laptop"), or by `label` where it stands for the environment itself (a
 * row says which environment by it alone). Until the environment names an
 * icon this window draws (one from before icons, or a newer environment's),
 * it is a dot, hidden from assistive technology unless labelled.
 */
export const EnvironmentGlyph = ({ view, label }: { readonly view: EnvironmentView | undefined; readonly label?: string }) => {
  const colour = environmentColour(view?.colour ?? null);
  const glyph = glyphOf(view?.icon ?? null);
  const style = colour === undefined ? undefined : { color: colour };
  const accent = colour === undefined && "text-cyan";
  if (glyph === undefined) {
    return (
      <span
        {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
        style={style}
        className={classes("size-2 shrink-0 rounded-full bg-current", accent)}
      />
    );
  }
  return (
    <svg
      role="img"
      aria-label={label ?? glyph.icon}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      className={classes("size-3.5 shrink-0", accent)}
    >
      {glyph.drawing}
    </svg>
  );
};

/** The badge: the icon, then the environment's name, "This machine" for the local environment before it has answered. */
export const EnvironmentBadge = ({ view }: { readonly view: EnvironmentView | undefined }) => (
  <span className="flex shrink-0 items-center gap-1 pr-1 font-medium text-ink">
    <EnvironmentGlyph view={view} />
    <span>{view?.name ?? THIS_MACHINE}</span>
  </span>
);
