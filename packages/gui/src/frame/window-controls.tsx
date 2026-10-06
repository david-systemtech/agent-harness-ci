import type { ShellWindowState } from "@agent-harness/client-runtime";
import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { IconButton } from "../ui/index.js";
import { useShell } from "../window-context.js";
import "./window-controls.css";

/** Subscribe before reading: a native event arriving during the read wins over its older snapshot. */
export const useWindowFrame = (): ShellWindowState | undefined => {
  const window = useShell()?.window;
  const [state, setState] = useState<ShellWindowState>();
  useEffect(() => {
    let active = true;
    let changed = false;
    setState(undefined);
    const stop = window?.onChange?.((value) => { changed = true; if (active) setState(value); });
    void window?.state?.().then((value) => { if (active && !changed) setState(value); }).catch(console.error);
    return () => { active = false; stop?.(); };
  }, [window]);
  return state;
};

/** A window-wide header's native frame (look §9.1): the drag region, and the traffic-light gutter on macOS outside full screen. */
export const nativeFrame = (state: ShellWindowState | undefined) => ({
  "data-native-frame": state?.platform,
  style: state?.platform === "darwin" && !state.fullScreen ? { paddingLeft: 76 } : undefined,
});

/** Native macOS controls remain with the OS; browser clients have no window buttons. */
export const WindowControls = ({ state }: { readonly state: ShellWindowState | undefined }) => {
  const window = useShell()?.window;
  if (state === undefined || state.platform === "darwin") return null;
  return <div role="group" aria-label="Window controls" className={`ml-1 flex shrink-0 gap-0.5 ${state.focused ? "" : "opacity-60"}`}>
    <IconButton label="Minimize" disabled={window?.minimize === undefined} onClick={() => window?.minimize?.()}><Minus aria-hidden="true" /></IconButton>
    <IconButton label={state.maximized ? "Restore" : "Maximize"} disabled={window?.toggleMaximize === undefined} onClick={() => window?.toggleMaximize?.()}>{state.maximized ? <Copy aria-hidden="true" /> : <Square aria-hidden="true" />}</IconButton>
    <IconButton label="Close window" className="hover:bg-signal hover:text-signal-ink" disabled={window?.close === undefined} onClick={() => window?.close?.()}><X aria-hidden="true" /></IconButton>
  </div>;
};
