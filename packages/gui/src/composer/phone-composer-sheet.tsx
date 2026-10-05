import { useCallback } from "react";
import { DialogContent, type DialogContentProps } from "../ui/dialog.js";

/** Portal bounds cannot inherit the conversation frame's keyboard viewport. */
export const PhoneComposerSheet = (props: Omit<DialogContentProps, "className" | "onOpenAutoFocus" | "ref">) => {
  const fit = useCallback((sheet: HTMLDivElement | null) => {
    const viewport = window.visualViewport;
    if (!sheet || !viewport) return;
    const resize = () => {
      // Keep the last unzoomed bounds, as the conversation frame does.
      if (viewport.scale !== 1) return;
      for (const [name, value] of Object.entries({ height: viewport.height, width: viewport.width, top: viewport.offsetTop, left: viewport.offsetLeft })) {
        sheet.style.setProperty(`--composer-sheet-${name}`, `${value}px`);
      }
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
    };
  }, []);
  return <DialogContent
    {...props}
    ref={fit}
    className="phone-composer-sheet top-auto translate-y-0"
    onOpenAutoFocus={event => {
      // Announce the sheet before an action's focus tooltip can cover its title.
      event.preventDefault();
      if (event.target instanceof HTMLElement) event.target.focus();
    }}
  />;
};
