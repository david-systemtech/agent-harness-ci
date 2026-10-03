import { act, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../test/harness.js";

it("lets scaled sidebar actions wrap and keeps New session and Restore keyboard accessible", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local" }] }, { presentation: { textSize: 20 } });
  const sidebar = await screen.findByRole("navigation", { name: "Sessions" });
  const start = within(sidebar).getByRole("button", { name: "New session" });
  // jsdom has no layout: these are the wrapping rules; hosted geometry checks the text bounds.
  expect(start.className.split(" ")).toContain("flex-wrap");
  expect(start.className.split(" ")).toContain("h-auto");
  expect(within(start).getByText("Ctrl+N").className.split(" ")).toContain("shrink-0");
  act(() => start.focus());
  await app.user.keyboard("{Enter}");
  expect(await screen.findByRole("region", { name: "New session" })).toBeDefined();

  const restore = within(sidebar).getByRole("button", { name: "Restore a deleted session…" });
  expect(restore.className.split(" ")).toContain("whitespace-normal");
  act(() => restore.focus());
  await app.user.keyboard(" ");
  expect(await screen.findByRole("dialog", { name: "Restore a deleted session" })).toBeDefined();
});
