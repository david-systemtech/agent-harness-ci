import { LOCAL_PLACEHOLDER_ID, homeEnvironment } from "@agent-harness/client-runtime";
import { DEFAULT_THEME, THEME_SEED_NAMES, type ParamsOf, type Theme } from "@agent-harness/contracts";
import { derive, windowBackground, type LadderName } from "@agent-harness/theme";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useFollowed, useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import { paintLadder } from "./paint.js";

/** What the window asks its home environment: the theme alone. */
const THEME_READ: ParamsOf<"settings.get"> = { keys: ["appearance.theme"] };

/** Whether two themes are one: the same name and the same seeds. */
const sameTheme = (a: Theme, b: Theme): boolean =>
  a.name === b.name && THEME_SEED_NAMES.every((seed) => a.seeds[seed].hue === b.seeds[seed].hue && a.seeds[seed].chroma === b.seeds[seed].chroma);

/** The media query that says whether the OS prefers light. */
const PREFERS_LIGHT = "(prefers-color-scheme: light)";

/** The ladder this client's OS prefers: light when it says so, dark when it says dark or nothing (the recorded palette's own). */
const osLadder = (view: Window): LadderName => (typeof view.matchMedia === "function" && view.matchMedia(PREFERS_LIGHT).matches ? "light" : "dark");

/** The ladder the OS prefers, followed as the OS switches. */
const useOsLadder = (view: Window): LadderName => {
  const subscribe = useCallback(
    (changed: () => void) => {
      if (typeof view.matchMedia !== "function") return () => undefined;
      const query = view.matchMedia(PREFERS_LIGHT);
      query.addEventListener("change", changed);
      return () => query.removeEventListener("change", changed);
    },
    [view],
  );
  return useSyncExternalStore(subscribe, () => osLadder(view));
};

/**
 * The theme in the window (ADR 0023; docs/specs/gui.md, "Theme: tokens, the
 * setting and the lint"). It paints before the window's first frame, before
 * anything is connected, the theme the last launch cached (the preset before
 * any) in this client's light or dark: its own, or the OS's, followed. It
 * reads `appearance.theme` from the home environment through the request
 * cache, which asks again on each `settings.changed`, and caches and repaints
 * a theme that differs from the one painted. Only the home environment's
 * theme is read, so a session, a pane or a heading of another environment
 * never recolours the window. Each Canvas painted is handed to the shell's
 * window background, which the desktop keeps and opens the next launch on.
 */
export const WindowTheme = () => {
  const runtime = useRuntime();
  const shell = useShell();
  const [cached, cache] = usePresentation("cachedTheme");
  const [lightOrDark] = usePresentation("lightOrDark");
  const os = useOsLadder(window);
  const ladder = lightOrDark === "system" ? os : lightOrDark;
  const theme = cached ?? DEFAULT_THEME;
  const derived = useMemo(() => derive(theme), [theme]);

  const handed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    paintLadder(document.documentElement, derived[ladder], ladder);
    const canvas = windowBackground(derived[ladder]);
    if (canvas === handed.current || runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.window").status !== "present") return;
    handed.current = canvas;
    shell?.window?.setBackgroundColour(canvas);
  }, [runtime, shell, derived, ladder]);

  const home = homeEnvironment(useObservable(runtime.projections.environments))?.environmentId;
  const answer = useFollowed(useMemo(() => (home === undefined ? undefined : runtime.requests.cached(home, "settings.get", THEME_READ)), [runtime, home]));
  const read = answer?.result?.values["appearance.theme"];
  useEffect(() => {
    if (read !== undefined && !sameTheme(read, theme)) cache(read);
  }, [read, theme, cache]);

  return null;
};
