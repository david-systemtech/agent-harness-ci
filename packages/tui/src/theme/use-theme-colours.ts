import { homeEnvironment, type EnvironmentView, type Runtime } from "@agent-harness/client-runtime";
import { DEFAULT_THEME, type ParamsOf } from "@agent-harness/contracts";
import { useMemo } from "react";
import { useFollow } from "../session/use-session.js";
import { themeColours, type ColourDepth, type ThemeColours } from "./colours.js";

/** What the terminal UI asks its home environment: the theme alone. */
const THEME_READ: ParamsOf<"settings.get"> = { keys: ["appearance.theme"] };

/**
 * The colours the terminal UI draws in (ADR 0023; docs/specs/tui.md,
 * "Rendering"). Under truecolour they are the home environment's theme's:
 * the local environment once it has answered, else the primary
 * (`homeEnvironment`, the window's own), its `appearance.theme` read
 * through the request cache, which asks again on every `settings.changed`,
 * so a theme another client sets is drawn within a round trip; the preset
 * until it is read. Without truecolour the theme is never drawn, so it is
 * never read.
 */
export const useThemeColours = (runtime: Runtime, views: readonly EnvironmentView[], depth: ColourDepth, request: () => void): ThemeColours => {
  const home = depth.truecolour ? homeEnvironment(views)?.environmentId : undefined;
  const read = useMemo(() => (home === undefined ? undefined : runtime.requests.cached(home, "settings.get", THEME_READ)), [runtime, home]);
  useFollow(read, request);
  const theme = read?.read().result?.values["appearance.theme"] ?? DEFAULT_THEME;
  return useMemo(() => themeColours(theme, depth), [theme, depth.truecolour, depth.ground]);
};
