import { useLayoutEffect, type RefObject } from "react";

/** Size the request against its own pane, after notices and fixed controls, retaining three reading lines. */
export function usePromptSpace(above: RefObject<HTMLDivElement | null>, enabled: boolean): void {
  useLayoutEffect(() => {
    const strip = above.current;
    const pane = strip?.closest('[aria-label="Session pane"]');
    const column = strip?.closest("[data-composer-column]");
    const transcript = pane?.querySelector('[aria-label="Transcript"]');
    if (!enabled || !strip || !pane || !column || !transcript) return;
    const measure = () => {
      const prompt = strip.querySelector('[aria-label="Parked prompt"]');
      const lineHeight = Number.parseFloat(getComputedStyle(transcript).lineHeight);
      if (!prompt || !Number.isFinite(lineHeight)) { strip.style.removeProperty("--session-prompt-height"); delete strip.dataset["promptSpace"]; delete strip.dataset["promptOverflow"]; return; }
      const otherRows = Array.from(pane.children).filter(child => child !== column && !child.contains(transcript));
      const reserved = otherRows.reduce((height, row) => height + row.getBoundingClientRect().height, 0);
      // Remove the prompt's current height from the composer before allocating it: this stays stable as it shrinks.
      const controls = Math.max(column.getBoundingClientRect().height, column.scrollHeight) - prompt.getBoundingClientRect().height;
      const reading = getComputedStyle(transcript.firstElementChild ?? transcript);
      const padding = (Number.parseFloat(reading.paddingTop) || 0) + (Number.parseFloat(reading.paddingBottom) || 0);
      const available = Math.max(0, pane.getBoundingClientRect().height - reserved - controls - (3 * lineHeight + padding));
      // Compact controls remove a composer row. Leave room for that row to return before expanding,
      // so its own height change cannot repeatedly cross the 400px entry threshold.
      const threshold = strip.dataset["promptSpace"] === "compact" ? 464 : 400;
      strip.dataset["promptSpace"] = available < threshold ? "compact" : "bounded";
      const decision = prompt.querySelector('[aria-label="Permission decision"]');
      const px = (value: string) => Number.parseFloat(value) || 0;
      const chrome = getComputedStyle(prompt);
      const minimum = decision && !decision.closest("[hidden]")
        ? (prompt.querySelector("header")?.getBoundingClientRect().height ?? 0) + decision.getBoundingClientRect().height
          + px(chrome.paddingTop) + px(chrome.paddingBottom) + px(chrome.borderTopWidth) + px(chrome.borderBottomWidth)
          + px(chrome.rowGap) + px(getComputedStyle(decision.parentElement!).rowGap) + 48
        : 0;
      strip.style.setProperty("--session-prompt-height", `${Math.max(available, minimum)}px`);
      if (available < minimum) strip.dataset["promptOverflow"] = "";
      else delete strip.dataset["promptOverflow"];
    };
    const observer = new ResizeObserver(measure);
    for (const element of [pane, column, strip, transcript]) observer.observe(element);
    measure();
    return () => { observer.disconnect(); strip.style.removeProperty("--session-prompt-height"); delete strip.dataset["promptSpace"]; delete strip.dataset["promptOverflow"]; };
  }, [above, enabled]);
}
