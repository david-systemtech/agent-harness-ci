import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Toaster, toast } from "../src/ui/toaster.js";
import { cleanupGui } from "./cleanup.js";

it("finishes a toast's exit callback before releasing the window", async () => {
  vi.useFakeTimers();
  try {
    render(<Toaster />);
    act(() => { toast.info("Mode: plan", { duration: 1 }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Mode: plan")).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText("Mode: plan").closest("[data-sonner-toast]")?.getAttribute("data-removed")).toBe("true");

    await cleanupGui();

    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => { await vi.runAllTimersAsync(); });
    vi.useRealTimers();
  }
});

it("finishes a queued toast update before releasing the window", async () => {
  vi.useFakeTimers();
  try {
    render(<Toaster />);
    act(() => { toast.success("Saved"); });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await cleanupGui();

    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await act(async () => { await vi.runAllTimersAsync(); });
    vi.useRealTimers();
  }
});
