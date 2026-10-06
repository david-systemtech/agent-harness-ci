import { useLayoutEffect, type RefObject } from "react";
import { phoneLayoutMedia } from "../frame/phone-frame.js";

/** The web frame is the single owner of keyboard bounds; never scroll its ancestors. */
export const usePhoneViewport = (owner: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = owner.current;
    if (!frame) return;
    const subscribedViewport = window.visualViewport;
    const root = document.documentElement;
    const media = phoneLayoutMedia();
    let layoutWidth = window.innerWidth;
    let unoccludedHeight = window.innerHeight;
    let focusHeight = unoccludedHeight;
    let keyboardOpen = false;
    let rotatedKeyboardHeight: number | null = null;
    const clearPhone = () => {
      root.removeAttribute("data-phone-viewport");
      frame.removeAttribute("data-phone-composing");
      for (const property of ["height", "top", "--phone-viewport-height"]) frame.style.removeProperty(property);
    };
    const fit = (event?: Event) => {
      const viewport = window.visualViewport;
      if (!media.some(query => query.matches)) {
        clearPhone();
        keyboardOpen = false; rotatedKeyboardHeight = null; unoccludedHeight = focusHeight = window.innerHeight;
        frame.style.maxHeight = `${viewport?.height ?? window.innerHeight}px`;
        return;
      }
      root.setAttribute("data-phone-viewport", "");
      // Keep the last unzoomed bounds. A second height observer would undo pinch zoom.
      if (viewport && viewport.scale !== 1) return;
      // A retained keyboard can resize layout and visual bounds together. Rebase
      // its closing height to the previous width on an orientation turn, rather
      // than treating the already-occluded new height as a closed keyboard.
      if (layoutWidth !== window.innerWidth) {
        const turned = (layoutWidth > unoccludedHeight) !== (window.innerWidth > window.innerHeight);
        const reference = turned ? layoutWidth : unoccludedHeight;
        layoutWidth = window.innerWidth;
        unoccludedHeight = focusHeight = keyboardOpen ? Math.max(window.innerHeight, reference) : window.innerHeight;
        rotatedKeyboardHeight = keyboardOpen ? focusHeight : null;
        if (!keyboardOpen) frame.removeAttribute("data-phone-composing");
      }
      const height = viewport?.height ?? window.innerHeight;
      frame.style.removeProperty("max-height");
      frame.style.height = `${height}px`;
      frame.style.top = `${viewport?.offsetTop ?? 0}px`;
      frame.style.setProperty("--phone-viewport-height", `${height}px`);
      const composing = event?.type === "focusin" && event.target instanceof Element && event.target.matches('[aria-label="Message"]');
      const messageFocused = document.activeElement instanceof Element && document.activeElement.matches('[aria-label="Message"]');
      if (composing && !keyboardOpen) focusHeight = unoccludedHeight;
      // Equal viewport heights cannot distinguish keyboard from browser chrome.
      // A quarter-height loss marks layout-resizing keyboards; keep the focus
      // snapshot through gradual resize events so animation cannot erase it.
      const keyboardNow = height < window.innerHeight || ((messageFocused || keyboardOpen) && (height <= focusHeight * 0.75 || (rotatedKeyboardHeight !== null && height < rotatedKeyboardHeight)));
      if (!keyboardNow) {
        rotatedKeyboardHeight = null;
        unoccludedHeight = window.innerHeight;
        // Follow the remaining growth during gradual closure, even with retained focus.
        if (keyboardOpen || !messageFocused || unoccludedHeight > focusHeight) focusHeight = unoccludedHeight;
      }
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
    media.forEach(query => query.addEventListener("change", fit));
    window.addEventListener("resize", fit);
    subscribedViewport?.addEventListener("resize", fit);
    subscribedViewport?.addEventListener("scroll", fit);
    frame.addEventListener("focusin", fit);
    return () => {
      media.forEach(query => query.removeEventListener("change", fit));
      window.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("scroll", fit);
      frame.removeEventListener("focusin", fit);
      clearPhone();
      frame.style.removeProperty("max-height");
    };
  }, [owner]);
};
