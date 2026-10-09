import { beforeEach, vi } from "vitest";

/** Own transient feedback's timers until shared cleanup unmounts and drains its exit callbacks. */
export const useToastTimers = (): void => {
  beforeEach(() => {
    // The scripted wire also yields on zero timeouts; let it progress while retaining every pending callback for teardown.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
  });
};
