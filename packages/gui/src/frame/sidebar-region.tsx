import { useRef, type PointerEvent } from "react";
import { Sidebar } from "../sidebar/sidebar.js";
import { usePresentation } from "../window-context.js";

/** What the sidebar calls the local environment before it has ever answered (#181). */
export { THIS_MACHINE } from "../connections/words.js";

/**
 * The sidebar region (docs/specs/gui.md, "The window and the sidebar"): the
 * sidebar of every environment's sessions, beside the session pane region.
 */
export const SidebarRegion = () => {
  const [storedWidth, setWidth] = usePresentation("sidebarWidth");
  const card = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; x: number; width: number; next: number } | null>(null);
  const width = sidebarPixels(storedWidth);
  const preview = (next: number) => {
    if (card.current !== null) card.current.style.width = `${next}px`;
    handle.current?.setAttribute("aria-valuenow", String(next));
    handle.current?.setAttribute("aria-valuetext", `${next} pixels`);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const held = drag.current;
    if (held === null || held.pointer !== event.pointerId) return;
    drag.current = null;
    setWidth(held.next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <div ref={card} data-sidebar-card className="relative min-h-0 shrink-0 rounded-lg border border-hairline bg-panel" style={{ width }}>
      <Sidebar />
      <div
        ref={handle}
        role="separator"
        tabIndex={0}
        aria-label="Resize the sidebar"
        aria-orientation="vertical"
        aria-valuemin={200}
        aria-valuemax={460}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Resize the sidebar · Left/Right: 16 pixels"
        className="absolute inset-y-2 right-0 w-2 cursor-col-resize rounded-sm outline-none hover:bg-beam/30 focus-visible:bg-beam/40"
        style={{ touchAction: "none" }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setWidth(sidebarPixels(width + (event.key === "ArrowLeft" ? -16 : 16)));
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, x: event.clientX, width, next: width };
        }}
        onPointerMove={(event) => {
          const held = drag.current;
          if (held === null || held.pointer !== event.pointerId) return;
          held.next = sidebarPixels(held.width + event.clientX - held.x);
          preview(held.next);
        }}
        onPointerUp={finish}
        onPointerCancel={finish}
        onLostPointerCapture={finish}
      />
    </div>
  );
};

/** Fixed-pixel presentation, including a safe reset for a nonfinite value. */
const sidebarPixels = (width: number | null): number => width === null || !Number.isFinite(width) ? 224 : Math.round(Math.max(200, Math.min(460, width)));
