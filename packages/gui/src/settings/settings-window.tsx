import { LOCAL_PLACEHOLDER_ID, homeEnvironment, parseSettingsLink, type EnvironmentView } from "@agent-harness/client-runtime";
import { readStoredRow, type SettingsRowId } from "@agent-harness/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useEscapeStep, useKeyAction } from "../keys/key-dispatch.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/**
 * Settings as the window holds it (docs/specs/gui.md, "Settings: the rail,
 * the rows and the addresses"; ADR 0027): whether it is open, the row it
 * shows, and the environment the last `environment` pane picked. Mod+,
 * (`app.settings.toggle`) opens and closes it; the palette, a step's link and
 * a settings deep link open it on a row. The row last opened is presentation,
 * kept as its id (`settingsRow`) and read against the registry, so an id it
 * no longer holds opens Set up; the environment picked lives as long as the
 * window does.
 */
export interface SettingsWindow {
  /** Whether Settings is open over the window. */
  readonly shown: boolean;
  /** The row it shows: the last one opened, or Set up when that is none the registry holds. */
  readonly row: SettingsRowId;
  /** The environment the last `environment` pane picked in this window; undefined until one was. */
  readonly picked: string | undefined;
  /** Opens Settings on `row` (the last row opened when none is named), on `environmentId` where its pane picks one. */
  open(row?: SettingsRowId | null, environmentId?: string): void;
  close(): void;
  /** Picks the environment `environment` panes edit, for as long as the window lives. */
  pick(environmentId: string): void;
}

const SettingsContext = createContext<SettingsWindow | null>(null);

/** Settings as the window holds it, anywhere in the window. */
export const useSettings = (): SettingsWindow => {
  const settings = use(SettingsContext);
  if (settings === null) throw new Error("Settings is reached inside the SettingsProvider, which the App holds.");
  return settings;
};

/**
 * Holds Settings for the window, wires Mod+, to open and close it, takes
 * Esc while it is open at its step of Escape's order, and opens a row on a
 * settings deep link the desktop is handed
 * (`shell.deepLinks.onOpen`: `agent-harness://settings/<address or row id>`).
 */
export const SettingsProvider = ({ children }: { readonly children: ReactNode }) => {
  const runtime = useRuntime();
  const shell = useShell();
  const [stored, keepRow] = usePresentation("settingsRow");
  const [shown, setShown] = useState(false);
  const [picked, setPicked] = useState<string | undefined>(undefined);

  const open = useCallback(
    (row?: SettingsRowId | null, environmentId?: string) => {
      if (row !== undefined && row !== null) keepRow(row);
      if (environmentId !== undefined) setPicked(environmentId);
      setShown(true);
    },
    [keepRow],
  );
  const close = useCallback(() => setShown(false), []);
  useKeyAction("app.settings.toggle", () => setShown((now) => !now));
  useEscapeStep("settings", close, shown);

  useEffect(() => {
    if (runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.deepLinks.onOpen").status !== "present") return undefined;
    return shell?.deepLinks?.onOpen?.((url) => {
      const link = parseSettingsLink(url);
      if (link !== undefined) open(link.row);
    });
  }, [runtime, shell, open]);

  const settings = useMemo<SettingsWindow>(() => ({ shown, row: readStoredRow(stored), picked, open, close, pick: setPicked }), [shown, stored, picked, open, close]);
  return <SettingsContext value={settings}>{children}</SettingsContext>;
};

/**
 * The environment an `environment` pane edits: the one the last such pane
 * picked in this window, else the home environment (the local one on the
 * desktop, else the primary one); undefined while the window knows none.
 */
export const usePickedEnvironment = (): EnvironmentView | undefined => {
  const { picked } = useSettings();
  const views = useObservable(useRuntime().projections.environments);
  return views.find((view) => view.environmentId === picked) ?? homeEnvironment(views);
};
