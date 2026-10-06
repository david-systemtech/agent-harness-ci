import { uuidv4, type ShellWebViewState } from "@agent-harness/client-runtime";
import { ArrowLeft, ArrowRight, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useIsKeyOf } from "../keys/key-dispatch.js";
import { hideColumn, useSideColumn } from "../side-column/column.js";
import { useGridPaneId } from "../grid/grid.js";
import { IconButton, Input, Tooltip } from "../ui/index.js";
import { sideColumnKey } from "../presentation.js";
import { usePresentation, useShell } from "../window-context.js";
import { useSettings } from "../settings/settings-window.js";
import { useBrowserPanes } from "./browser-panes.js";

/** The native page occupies only the rectangle below the address line; controls stay in the renderer. */
export const BrowserPane = ({
  environmentId,
  sessionId,
  onScreen,
}: {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly onScreen: boolean;
}) => {
  const { shown: settingsShown } = useSettings();
  const visible = onScreen && !settingsShown;
  const paneId = useGridPaneId();
  const panes = useBrowserPanes();
  const [partitions, setPartitions] = usePresentation("browserPartitions");
  const partitionKey = `${paneId} ${sideColumnKey({ environmentId, sessionId })}`;
  const partition = partitions[partitionKey];
  useEffect(() => {
    if (paneId && partition === undefined) setPartitions((held) => (held[partitionKey] ? held : { ...held, [partitionKey]: uuidv4() }));
  }, [paneId, partition, partitionKey, setPartitions]);
  const isToggle = useIsKeyOf("app.browser.toggle");
  const [, changeColumn] = useSideColumn({ environmentId, sessionId });
  const views = useShell()?.webView;
  const surface = useRef<HTMLDivElement>(null);
  const [id, setId] = useState<string>();
  const [state, setState] = useState<ShellWebViewState>({ url: "about:blank", canGoBack: false, canGoForward: false, loading: false });
  const [address, setAddress] = useState("about:blank");
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!views || !paneId || !partition) return;
    let active = true;
    setId(undefined);
    void panes
      .page(paneId, { environmentId, sessionId }, partition)
      .then(async (id) => {
        if (!active) return;
        setId(id);
        const state = await views.state(id);
        if (active) {
          setState(state);
          setAddress(state.url);
        }
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [views, panes, paneId, environmentId, sessionId, partition]);
  useEffect(() => {
    if (!views || !id) return;
    return views.onChange((changed, state) => {
      if (changed === id) {
        setState(state);
        setAddress(state.url);
      }
    });
  }, [views, id]);
  useEffect(() => {
    if (!views || !id) return;
    if (!visible) {
      views.hide(id);
      return;
    }
    let frame = 0;
    let last = "";
    const place = () => {
      const rect = surface.current?.getBoundingClientRect();
      if (rect) {
        const bounds = {
          x: Math.max(0, Math.round(rect.x)),
          y: Math.max(0, Math.round(rect.y)),
          width: Math.max(0, Math.round(rect.width)),
          height: Math.max(0, Math.round(rect.height)),
        };
        const next = JSON.stringify(bounds);
        if (next !== last) {
          last = next;
          views.attach(id, bounds);
        }
      }
      // Position can change without the page's size changing (a neighbouring pane or sidebar resize).
      frame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      views.hide(id);
    };
  }, [views, id, visible]);
  useEffect(() => {
    if (!views || !id || !visible) return;
    return views.onKey((pressedId, key) => {
      if (pressedId === id && isToggle(key)) changeColumn((held) => hideColumn(held, true));
    });
  }, [views, id, visible, isToggle, changeColumn]);
  const navigate = () => {
    if (!views || !id) return;
    setError(undefined);
    // A bare host with a numeric port looks like a scheme (notably localhost:3000).
    const hostWithPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(address);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(address) && !hostWithPort;
    const url = hasScheme ? address : `https://${address}`;
    void views.navigate(id, url).catch((error: unknown) => setError(String(error)));
  };
  return (
    <>
      <form
        aria-label="Browser navigation"
        className="flex shrink-0 items-center gap-1 border-b border-hairline bg-panel px-2 py-1"
        onSubmit={(event) => {
          event.preventDefault();
          navigate();
        }}
      >
        <IconButton label="Back" keys="Enter / Space" size="icon-xs" className="[&_svg]:size-3.5" disabled={!id || !state.canGoBack} onClick={() => id && views?.back(id)}>
          <ArrowLeft aria-hidden="true" />
        </IconButton>
        <IconButton label="Forward" keys="Enter / Space" size="icon-xs" className="[&_svg]:size-3.5" disabled={!id || !state.canGoForward} onClick={() => id && views?.forward(id)}>
          <ArrowRight aria-hidden="true" />
        </IconButton>
        <IconButton label={state.loading ? "Stop" : "Reload"} keys="Enter / Space" size="icon-xs" className="[&_svg]:size-3.5" disabled={!id} onClick={() => id && (state.loading ? views?.stop(id) : views?.reload(id))}>
          {state.loading ? <Square aria-hidden="true" /> : <RotateCw aria-hidden="true" />}
        </IconButton>
        <Tooltip content="Address" keys="Enter to navigate · Escape to restore">
          <Input
            aria-label="Address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              setAddress(state.url);
            }}
            className="h-auto min-w-0 flex-1 rounded-md border-hairline-strong bg-wash px-2 py-1 font-mono text-xs md:text-xs dark:bg-wash"
          />
        </Tooltip>
        <IconButton label="Go" keys="Enter" type="submit" size="icon-xs" className="[&_svg]:size-3.5" disabled={!id}>
          <ArrowRight aria-hidden="true" />
        </IconButton>
      </form>
      {error && (
        <p role="status" className="shrink-0 border-b border-amber/45 bg-amber/10 px-2 py-1 text-xs text-amber">
          {error}
        </p>
      )}
      <div ref={surface} aria-label="Browser page" className="min-h-0 flex-1" />
    </>
  );
};
