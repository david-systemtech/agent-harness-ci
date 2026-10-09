import { act, cleanup } from "@testing-library/react";
import { vi } from "vitest";

/** Unmounts the GUI before its jsdom window is released. */
export const cleanupGui = async (): Promise<void> => {
  cleanup();
  if (vi.isFakeTimers()) {
    // Sonner clears expiry on unmount, but an exit already in progress still owns a callback into React.
    await act(async () => { await vi.runAllTimersAsync(); });
  } else {
    // Radix returns focus on the next task; finish it before another file replaces this window.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
