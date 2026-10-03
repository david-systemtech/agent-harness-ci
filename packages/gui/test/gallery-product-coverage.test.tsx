import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { productScene } from "../gallery/product-scene.js";

it("captures queued work and its actions over the real session runtime", async () => {
  const Scene = await productScene("queue");
  const view = render(<Scene ladder="dark" />);
  try {
    const queued = await screen.findByRole("article", { name: "Queued message" });
    expect(within(queued).getByRole("button", { name: "Read now" })).toBeTruthy();
    expect(within(queued).getByRole("button", { name: "Edit" })).toBeTruthy();
  } finally { view.unmount(); }
});


it("captures steering, stopping and durable history with the product's real state labels", async () => {
  for (const kind of ["steering", "stopping", "history"] as const) {
    const Scene = await productScene(kind);
    const view = render(<Scene ladder="light" />);
    try {
      if (kind === "steering") await screen.findByRole("article", { name: "Steering message" });
      if (kind === "stopping") expect((await screen.findByRole("button", { name: "Stopping…" })).hasAttribute("disabled")).toBe(true);
      if (kind === "history") {
        await screen.findByRole("region", { name: "Latest rewind" });
        await screen.findByRole("button", { name: "Forked from Earlier receipts" });
        const check = await screen.findByRole("article", { name: "Workspace check" });
        expect(check.textContent).toContain("12 checks passed");
      }
    } finally { view.unmount(); }
  }
});
