import { act, screen, within } from "@testing-library/react";
import type { RenderedApp } from "./harness.js";

/** jsdom's window-sized divider intercepts pointer presses; open the dropdown with its keyboard control. */
export const openHeaderMenu = async (app: RenderedApp) => {
  const shown = screen.queryByRole("menu", { name: "More" });
  if (shown !== null) return shown;
  if (screen.queryByRole("menu") !== null) await app.user.keyboard("{Escape}");
  act(() => within(screen.getByRole("banner")).getByRole("button", { name: "More" }).focus());
  await app.user.keyboard("{Enter}");
  return screen.findByRole("menu", { name: "More" });
};

export const chooseHeaderAction = async (app: RenderedApp, name: string) => {
  const menu = await openHeaderMenu(app);
  await app.user.click(within(menu).getByRole("menuitem", { name }));
};
