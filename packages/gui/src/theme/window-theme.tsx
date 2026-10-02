import { LOCAL_PLACEHOLDER_ID, homeEnvironment } from "@agent-harness/client-runtime";
import { DEFAULT_THEME, THEME_SEED_NAMES, type ParamsOf, type Theme } from "@agent-harness/contracts";
import { derive, windowBackground, type LadderName } from "@agent-harness/theme";
import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useFollowed, useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";
import { paintLadder } from "./paint.js";

/** What the window asks its home environment: the theme alone. */
const THEME_READ: ParamsOf<"settings.get"> = { keys: ["appearance.theme"] };

/** Whether two themes are one: the same name and the same seeds. */
export const sameTheme = (a: Theme, b: Theme): boolean =>
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

/** Shows a theme on the window over its own until the release it answers is called. */
type ShowPreview = (theme: Theme) => () => void;

const PreviewContext = createContext<ShowPreview | null>(null);

/** One preview shown, by whoever showed it. */
interface Preview {
  readonly key: symbol;
  readonly theme: Theme;
}

/**
 * The theme in the window, and the theme picker's live preview over it
 * (ADR 0023; #1194): a picker shows its candidate, which the window paints
 * in place of its home environment's theme until the picker releases it,
 * the latest shown painted while several are. A preview is this window's
 * alone: nothing is written, cached or handed to the shell for it.
 */
export const WindowThemeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [previews, setPreviews] = useState<readonly Preview[]>([]);
  const show = useCallback<ShowPreview>((theme) => {
    const key = Symbol("preview");
    setPreviews((now) => [...now, { key, theme }]);
    return () => setPreviews((now) => now.filter((preview) => preview.key !== key));
  }, []);
  return (
    <PreviewContext value={show}>
      <WindowTheme preview={previews.at(-1)?.theme} />
      {children}
    </PreviewContext>
  );
};

/** Paints `candidate` on the window while it is given and the component is mounted: a picker's live preview. */
export const usePreviewTheme = (candidate: Theme | undefined): void => {
  const show = use(PreviewContext);
  useEffect(() => (candidate === undefined || show === null ? undefined : show(candidate)), [show, candidate]);
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
 * A picker's preview is painted over the theme while it is shown; the
 * window background stays the theme's.
 */
const WindowTheme = ({ preview }: { readonly preview: Theme | undefined }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const [cached, cache] = usePresentation("cachedTheme");
  const [lightOrDark] = usePresentation("lightOrDark");
  const os = useOsLadder(window);
  const ladder = lightOrDark === "system" ? os : lightOrDark;
  const theme = cached ?? DEFAULT_THEME;
  const derived = useMemo(() => derive(theme), [theme]);
  const painted = useMemo(() => (preview === undefined ? derived : derive(preview)), [preview, derived]);

  useLayoutEffect(() => paintLadder(document.documentElement, painted[ladder], ladder), [painted, ladder]);
  const handed = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
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
