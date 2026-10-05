import { render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { settingsNoticesScene, settingsNoticesGeometry } from "../gallery/settings-notices-scene.js";

it.each([{ stacked: false, textSize: 14, count: 1 }, { stacked: true, textSize: 14, count: 5 }, { stacked: true, textSize: 20, count: 5 }])(
  "captures Settings notices with $count banners at text size $textSize",
  async ({ stacked, textSize, count }) => {
    const Scene = await settingsNoticesScene(stacked, textSize);
    const view = render(<Scene ladder="dark" />);
    try {
      const dialog = await screen.findByRole("dialog", { name: "Settings" });
      const notices = await within(dialog).findByRole("region", { name: "Notifications" });
      await waitFor(() => expect(within(notices).getAllByRole("listitem")).toHaveLength(count));
      expect(within(notices).getAllByRole("button", { name: "Dismiss" })).toHaveLength(count);
      expect(notices.classList.contains("overflow-y-auto")).toBe(false);
      expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(String(textSize / 14));
      for (const viewport of [{ width: 1400, height: 900 }, { width: 1024, height: 768 }]) {
        for (const measure of settingsNoticesGeometry(textSize)(viewport)) {
          expect(document.querySelectorAll(measure.selector).length, measure.selector).toBeGreaterThan(0);
        }
      }
    } finally { view.unmount(); }
  },
);
