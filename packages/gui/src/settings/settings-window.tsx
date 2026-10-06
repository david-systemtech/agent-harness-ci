import { LOCAL_PLACEHOLDER_ID, homeEnvironment, parseSettingsLink, type EnvironmentView } from "@agent-harness/client-runtime";
import { readStoredRow, type SettingsRowId } from "@agent-harness/contracts";
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useEscapeStep, useKeyAction } from "../keys/key-dispatch.js";
import { useObservable, usePresentation, useRuntime, useShell } from "../window-context.js";

/**
 * Settings as the window holds it (docs/specs/gui.md, "Settings: the rail,
 * the rows and the addresses"; ADR 0027): whether it is open, the row it
 * shows, and the environment the last `environment` pane picked. Mod+,
 * (`app.settings.toggle`) opens and closes it; the palette, a step's link,
 * a settings deep link and `/settings [row]` open it on a row. The row last
 * opened is presentation, kept as its id (`settingsRow`) and read against
 * the registry, so an id it no longer holds opens Set up; the environment
 * picked lives as long as the window does.
 */
export interface SettingsWindow {
  /** Whether Settings is open over the window. */
  readonly shown: boolean;
  /** The row it shows: the last one opened, or Set up when that is none the registry holds. */
  readonly row: SettingsRowId;
  /** The environment the last `environment` pane picked in this window; undefined until one was. */
  readonly picked: string | undefined;
  /** The part of the row's pane the last opening asked to go to; undefined when it asked for none. */
  readonly part: SettingsPart | undefined;
  /** How many times Settings was opened, so a part an opening asks for again is gone to again. */
  readonly openings: number;
  /** Opens Settings on `row` (the last row opened when none is named), on `environmentId` where its pane picks one, at `part` of its pane. */
  open(row?: SettingsRowId | null, environmentId?: string, part?: SettingsPart): void;
  close(): void;
  /** Picks the environment `environment` panes edit, for as long as the window lives. */
  pick(environmentId: string): void;
}

/** A part of a pane an opening may go to, which takes the focus: Your machines' Add a machine (#577) and the picked environment's Browser origins (#1713), About's Managed tools (#426). */
export type SettingsPart = "add-a-machine" | "browser-origins" | "managed-tools";

const SettingsContext = createContext<SettingsWindow | null>(null);
const NoticeHostContext = createContext<{ host: HTMLDivElement | null; setHost: (host: HTMLDivElement | null) => void } | null>(null);

/** One mounted notice list moves into Settings while its modal covers the session window. */
export const useSettingsNoticeHost = () => use(NoticeHostContext);

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
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const noticeHost = useMemo(() => ({ host, setHost }), [host]);
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const [part, setPart] = useState<SettingsPart | undefined>(undefined);
  const [openings, setOpenings] = useState(0);

  const open = useCallback(
    (row?: SettingsRowId | null, environmentId?: string, at?: SettingsPart) => {
      if (row !== undefined && row !== null) keepRow(row);
      if (environmentId !== undefined) setPicked(environmentId);
      setPart(at);
      setOpenings((count) => count + 1);
      setShown(true);
    },
    [keepRow],
  );
  const close = useCallback(() => setShown(false), []);
  // Mod+, reopens Settings as an opening that names nothing: on the last row, at no part of its pane.
  useKeyAction("app.settings.toggle", () => (shown ? close() : open()));
  useEscapeStep("settings", close, shown);

  useEffect(() => {
    if (runtime.capability(LOCAL_PLACEHOLDER_ID, "shell.deepLinks.onOpen").status !== "present") return undefined;
    return shell?.deepLinks?.onOpen?.((url) => {
      const link = parseSettingsLink(url);
      if (link !== undefined) open(link.row);
    });
  }, [runtime, shell, open]);

  const settings = useMemo<SettingsWindow>(() => ({ shown, row: readStoredRow(stored), picked, part, openings, open, close, pick: setPicked }), [shown, stored, picked, part, openings, open, close]);
  return <SettingsContext value={settings}><NoticeHostContext value={noticeHost}>{children}</NoticeHostContext></SettingsContext>;
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
