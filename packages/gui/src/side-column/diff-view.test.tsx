import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView } from "./diff-view.js";

describe("shared diff view", () => {
  it("numbers both sides independently, highlights changed characters, and keeps metadata out of line counts", () => {
    const { container } = render(<DiffView text={"--- a/totals.ts\n+++ b/totals.ts\n@@ -7,2 +9,2 @@\n const ready = true;\n-const total = 2;\n+const total = 3;\n\\ No newline at end of file"} />);
    expect([...container.querySelectorAll("[data-diff-gutter]")].map((node) => node.textContent)).toEqual(["", "", "7", "9", "8", "", "", "10", "", ""]);
    expect(screen.getByText("2", { selector: "[data-diff-change]" })).toBeDefined();
    expect(screen.getByText("3", { selector: "[data-diff-change]" })).toBeDefined();
  });
  it("caps large diffs and says when content was clipped", () => {
    const { container } = render(<DiffView text={"@@ -0,0 +1,700 @@\n" + Array.from({ length: 700 }, (_, index) => `+row ${index}`).join("\n")} />);
    expect(screen.getByText(/Diff clipped/)).toBeDefined();
    expect(container.textContent).toContain("row 598");
    expect(container.textContent).not.toContain("row 599");
  });
});
