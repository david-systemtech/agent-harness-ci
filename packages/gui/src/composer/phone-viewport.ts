import { useEffect, type RefObject } from "react";

/** Keep the conversation above the keyboard on browsers whose layout viewport stays tall. */
export const usePhoneViewport = (anchor: RefObject<HTMLElement | null>) => {
  useEffect(() => {
    const frame = anchor.current?.closest<HTMLElement>("[data-web-client]");
    const viewport = window.visualViewport;
    if (!frame || !viewport) return;
    const fit = () => {
      // A zoomed visual viewport must not resize the page under the person's fingers.
      if (viewport.scale !== 1) return;
      if (viewport.width >= 640) { frame.style.removeProperty("--phone-viewport-height"); return; }
      frame.style.setProperty("--phone-viewport-height", `${viewport.height}px`);
      const active = document.activeElement;
      if (active instanceof HTMLElement && frame.contains(active)) active.scrollIntoView({ block: "nearest" });
    };
    fit();
    viewport.addEventListener("resize", fit);
    // Viewport scrolling must not pull a manually scrolled composer back to the focused control.
    frame.addEventListener("focusin", fit);
    return () => {
      viewport.removeEventListener("resize", fit);
      frame.removeEventListener("focusin", fit);
      frame.style.removeProperty("--phone-viewport-height");
    };
  }, [anchor]);
};
