import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ContextUsageScene from "../gallery/scenes/context-usage.js";

// The gallery uses the same ring as the status line, including its unavailable case.
describe("the context usage gallery", () => {
  it("shows before-run unknown, known zero, actual model change, clamped share, unknown scale and absent capability", () => {
    render(<ContextUsageScene />);
    expect(within(screen.getByLabelText("Before run")).getByRole("img", { name: "Context: unknown" })).toBeTruthy();
    expect(within(screen.getByLabelText("Known zero")).getByRole("img", { name: "Context: 0%" })).toBeTruthy();
    expect(within(screen.getByLabelText("Actual run model changed")).getByRole("img", { name: "Context: 80%" })).toBeTruthy();
    expect(within(screen.getByLabelText("Clamped share")).getByRole("img", { name: "Context: 100%" })).toBeTruthy();
    expect(within(screen.getByLabelText("Unknown scale")).getByRole("img", { name: "Context: unknown" })).toBeTruthy();
    expect(within(screen.getByLabelText("Absent capability")).queryByRole("button")).toBeNull();
  });
});
