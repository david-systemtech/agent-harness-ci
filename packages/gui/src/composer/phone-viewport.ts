import { useLayoutEffect, type RefObject } from "react";

/** The web frame is the single owner of keyboard bounds; never scroll its ancestors. */
export const usePhoneViewport = (owner: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = owner.current;
    if (!frame) return;
    const subscribedViewport = window.visualViewport;
    const root = document.documentElement;
    let fullHeight = window.innerHeight;
    let keyboardOpen = false;
    const clearPhone = () => {
      root.removeAttribute("data-phone-viewport");
      frame.removeAttribute("data-phone-composing");
      for (const property of ["height", "top", "--phone-viewport-height"]) frame.style.removeProperty(property);
    };
    const fit = (event?: Event) => {
      const viewport = window.visualViewport;
      if (window.innerWidth >= 640) {
        clearPhone();
        keyboardOpen = false; fullHeight = window.innerHeight;
        frame.style.maxHeight = `${viewport?.height ?? window.innerHeight}px`;
        return;
      }
      root.setAttribute("data-phone-viewport", "");
      // Keep the last unzoomed bounds. A second height observer would undo pinch zoom.
      if (viewport && viewport.scale !== 1) return;
      const height = viewport?.height ?? window.innerHeight;
      frame.style.removeProperty("max-height");
      frame.style.height = `${height}px`;
      frame.style.top = `${viewport?.offsetTop ?? 0}px`;
      frame.style.setProperty("--phone-viewport-height", `${height}px`);
      const composing = event?.type === "focusin" && event.target instanceof Element && event.target.matches('[aria-label="Message"]');
      const messageFocused = document.activeElement instanceof Element && document.activeElement.matches('[aria-label="Message"]');
      // Refresh unoccluded bounds before composing; keep them while a keyboard
      // may shrink both viewports, including through button taps.
      fullHeight = !keyboardOpen && !messageFocused ? window.innerHeight : Math.max(fullHeight, window.innerHeight);
      const keyboardNow = height < fullHeight;
      const keyboardOpened = keyboardNow && !keyboardOpen && messageFocused;
      // Keep the reserve through button taps: releasing it on blur can move Send
      // between pointer-down and pointer-up when the dock is already scrolling.
      if (composing || keyboardOpened) frame.setAttribute("data-phone-composing", "");
      else if (keyboardOpen && !keyboardNow) frame.removeAttribute("data-phone-composing");
      keyboardOpen = keyboardNow;
      // Only this composer's transcript repins after the shell's bounds change.
      if (composing || keyboardOpened) document.activeElement?.closest("[data-dock-owner]")?.dispatchEvent(new Event("phone-composer-fit"));
    };
    fit();
    window.addEventListener("resize", fit);
    subscribedViewport?.addEventListener("resize", fit);
    subscribedViewport?.addEventListener("scroll", fit);
    frame.addEventListener("focusin", fit);
    return () => {
      window.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("scroll", fit);
      frame.removeEventListener("focusin", fit);
      clearPhone();
      frame.style.removeProperty("max-height");
    };
  }, [owner]);
};
