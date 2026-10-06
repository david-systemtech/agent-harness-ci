import { useLayoutEffect, type RefObject } from "react";
import { phoneLayoutMedia } from "../frame/phone-frame.js";

const clipped = (overflow: string) => overflow === "hidden" || overflow === "clip";

/** The web frame is the single owner of keyboard bounds; never scroll its ancestors. */
export const usePhoneViewport = (owner: RefObject<HTMLElement | null>) => {
  useLayoutEffect(() => {
    const frame = owner.current;
    if (!frame) return;
    const subscribedViewport = window.visualViewport;
    const root = document.documentElement;
    const media = phoneLayoutMedia();
    let layoutWidth = window.innerWidth;
    let unoccludedWidth = window.innerWidth;
    let unoccludedHeight = window.innerHeight;
    let focusHeight = unoccludedHeight;
    let keyboardOpen = false;
    let rotatedKeyboardHeight: number | null = null;
    const clearPhone = () => {
      root.removeAttribute("data-phone-viewport");
      frame.removeAttribute("data-phone-composing");
      for (const property of ["height", "top", "--phone-viewport-height"]) frame.style.removeProperty(property);
    };
    // Revealing focused Message, a browser also scrolls the clipped boxes around
    // the dock, against bounds from before a layout-resizing keyboard. A reader
    // cannot scroll those back, so the shell and every clipped axis enclosing a
    // dock stay at their origin; the reader's own scrollers keep their place.
    const release = (box: Element) => {
      const style = getComputedStyle(box), shell = box === frame;
      const top = box.scrollTop !== 0 && (shell || clipped(style.overflowY));
      const left = box.scrollLeft !== 0 && (shell || clipped(style.overflowX));
      if (!(top || left) || !(shell || box.querySelector("[data-dock-owner]"))) return;
      if (top) box.scrollTop = 0;
      if (left) box.scrollLeft = 0;
    };
    const releaseDocks = () => {
      for (const owner of frame.querySelectorAll("[data-dock-owner]")) {
        for (let box = owner.parentElement; box !== null && frame.contains(box); box = box.parentElement) release(box);
      }
    };
    const released = (event: Event) => { if (event.target instanceof Element) release(event.target); };
    const fit = (event?: Event) => {
      const viewport = window.visualViewport;
      if (!media.some(query => query.matches)) {
        clearPhone();
        keyboardOpen = false; rotatedKeyboardHeight = null; unoccludedWidth = window.innerWidth; unoccludedHeight = focusHeight = window.innerHeight;
        frame.style.maxHeight = `${viewport?.height ?? window.innerHeight}px`;
        return;
      }
      root.setAttribute("data-phone-viewport", "");
      // Keep the last unzoomed bounds. A second height observer would undo pinch zoom.
      if (viewport && viewport.scale !== 1) return;
      // Match the new width to the held unoccluded axes. A keyboard-height
      // intermediate can still look landscape while turning back to portrait.
      if (layoutWidth !== window.innerWidth) {
        const turned = Math.abs(window.innerWidth - unoccludedHeight) < Math.abs(window.innerWidth - unoccludedWidth);
        const reference = turned ? unoccludedWidth : unoccludedHeight;
        unoccludedWidth = layoutWidth = window.innerWidth;
        unoccludedHeight = focusHeight = keyboardOpen ? Math.max(window.innerHeight, reference) : window.innerHeight;
        rotatedKeyboardHeight = keyboardOpen ? focusHeight : null;
        if (!keyboardOpen) frame.removeAttribute("data-phone-composing");
      }
      const height = viewport?.height ?? window.innerHeight;
      frame.style.removeProperty("max-height");
      frame.style.height = `${height}px`;
      frame.style.top = `${viewport?.offsetTop ?? 0}px`;
      frame.style.setProperty("--phone-viewport-height", `${height}px`);
      releaseDocks();
      const composing = event?.type === "focusin" && event.target instanceof Element && event.target.matches('[aria-label="Message"]');
      const messageFocused = document.activeElement instanceof Element && document.activeElement.matches('[aria-label="Message"]');
      if (composing && !keyboardOpen) focusHeight = unoccludedHeight;
      // Equal viewport heights cannot distinguish keyboard from browser chrome.
      // A quarter-height loss marks layout-resizing keyboards; keep the focus
      // snapshot through gradual resize events so animation cannot erase it.
      const keyboardNow = height < window.innerHeight || ((messageFocused || keyboardOpen) && (height <= focusHeight * 0.75 || (rotatedKeyboardHeight !== null && height < rotatedKeyboardHeight)));
      if (!keyboardNow) {
        rotatedKeyboardHeight = null;
        unoccludedWidth = window.innerWidth;
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
    frame.addEventListener("scroll", released, true);
    return () => {
      media.forEach(query => query.removeEventListener("change", fit));
      window.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("resize", fit);
      subscribedViewport?.removeEventListener("scroll", fit);
      frame.removeEventListener("focusin", fit);
      frame.removeEventListener("scroll", released, true);
      clearPhone();
      frame.style.removeProperty("max-height");
    };
  }, [owner]);
};
