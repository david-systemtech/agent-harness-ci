import { ENVIRONMENT_ICONS, type EnvironmentIcon } from "@agent-harness/contracts";
import type { ReactNode } from "react";

/**
 * The window's drawing of each of the ten icons an environment may name
 * (ADR 0025's fixed set; workspace-picker spec, "Name, icon and colour"):
 * line drawings on a 16-unit grid, stroked in `currentColor`, so the
 * element drawing one paints it in the environment's colour token and no
 * drawing holds a colour of its own (ADR 0023). A dot on a line is a stroke
 * a hundredth long, its round caps drawing it.
 */
const GLYPHS: Readonly<Record<EnvironmentIcon, ReactNode>> = {
  laptop: (
    <>
      <rect x="3" y="3.5" width="10" height="7" rx="1" />
      <path d="M1.5 12.5h13" />
    </>
  ),
  desktop: (
    <>
      <rect x="2" y="2.5" width="12" height="8" rx="1" />
      <path d="M8 10.5v3M5.5 13.5h5" />
    </>
  ),
  server: (
    <>
      <rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
      <rect x="2.5" y="9" width="11" height="4.5" rx="1" />
      <path d="M5 4.75h.01M5 11.25h.01" />
    </>
  ),
  nas: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.24 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.24 2 5 2s5-.9 5-2" />
    </>
  ),
  cloud: <path d="M4.5 12.5h7a2.75 2.75 0 0 0 0-5.5h-.1a3.75 3.75 0 0 0-7.3.6 2.5 2.5 0 0 0 .4 4.9z" />,
  container: (
    <>
      <path d="M8 1.75 14 5v6l-6 3.25L2 11V5z" />
      <path d="m2 5 6 3.25L14 5M8 8.25v6" />
    </>
  ),
  board: (
    <>
      <rect x="4" y="4" width="8" height="8" rx="1" />
      <path d="M6.5 1.5V4M9.5 1.5V4M6.5 12v2.5M9.5 12v2.5M1.5 6.5H4M1.5 9.5H4M12 6.5h2.5M12 9.5h2.5" />
    </>
  ),
  home: (
    <>
      <path d="M1.75 7.5 8 2.25l6.25 5.25" />
      <path d="M3.5 6.25v7.25h9V6.25M6.5 13.5v-4h3v4" />
    </>
  ),
  office: (
    <>
      <rect x="3" y="1.75" width="10" height="12.5" rx="1" />
      <path d="M5.75 4.5h1M9.25 4.5h1M5.75 7.5h1M9.25 7.5h1M7 14.25v-3h2v3" />
    </>
  ),
  lab: (
    <>
      <path d="M5.75 1.75h4.5M6.5 1.75v4.5l-3.75 6.4a1.1 1.1 0 0 0 .95 1.6h8.6a1.1 1.1 0 0 0 .95-1.6L9.5 6.25v-4.5" />
      <path d="M4.5 10h7" />
    </>
  ),
};

/**
 * The drawing of the icon an environment names, or none for no icon or a
 * name that is none of the ten (a newer environment's), which the badge
 * draws as a dot.
 */
export const glyphOf = (icon: string | null): { readonly icon: EnvironmentIcon; readonly drawing: ReactNode } | undefined => {
  const known = ENVIRONMENT_ICONS.find((name) => name === icon);
  return known === undefined ? undefined : { icon: known, drawing: GLYPHS[known] };
};
