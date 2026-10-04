import { act, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { renderApp } from "../../test/harness.js";

it("keeps tab focus in the command palette and closes by tap back to the draft", async () => {
  const app = await renderApp({ environments: [{ name: "desk", reach: "local", sessions: [{ title: "Notes" }] }] });
  app.open("desk");
  const box = await screen.findByRole("textbox", { name: "Message" });
  act(() => box.focus());
  await app.user.keyboard("Keep the draft{Control>}k{/Control}");
  const palette = screen.getByRole("dialog", { name: "Command palette" });
  const close = within(palette).getByRole("button", { name: "Close command palette" });
  await app.user.tab();
  expect(palette.contains(document.activeElement)).toBe(true);
  await app.user.tab();
  expect(palette.contains(document.activeElement)).toBe(true);
  await app.user.click(close);
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  expect(document.activeElement).toBe(box);
  expect(box).toHaveProperty("value", "Keep the draft");
});
