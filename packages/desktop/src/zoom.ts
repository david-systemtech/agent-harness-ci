import type { DesktopElectron, ElectronContents, ElectronInput } from "./electron.js";
import type { ShellPlatform } from "@agent-harness/client-runtime";

/** Desktop zoom stays between 50% and 200%, in ten percentage point steps. */
export const changeZoom = (page: ElectronContents, action: unknown): void => {
  if (action !== "in" && action !== "out" && action !== "reset") throw new TypeError("A zoom action is in, out or reset.");
  const factor = action === "reset" ? 1 : (Math.round(page.getZoomFactor() * 10) + (action === "in" ? 1 : -1)) / 10;
  page.setZoomFactor(Math.max(0.5, Math.min(2, factor)));
};

/** Preserve the standard native menus, but send View's zoom clicks through the same limits as the keys. */
export const installZoomMenu = (menu: DesktopElectron["menu"], page: ElectronContents, os: ShellPlatform): void => {
  menu.set([
    ...(os === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { label: "Actual Size", accelerator: "CommandOrControl+0", click: () => changeZoom(page, "reset") },
      { label: "Zoom In", accelerator: "CommandOrControl+Plus", click: () => changeZoom(page, "in") },
      { label: "Zoom Out", accelerator: "CommandOrControl+-", click: () => changeZoom(page, "out") },
      { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ]);
};

/** Read the character, including shifted plus and keypad add, rather than a layout's physical key. */
const zoomAction = (input: ElectronInput, os: ShellPlatform): "in" | "out" | "reset" | undefined => {
  if (input.type !== "keyDown" || input.alt || (os === "darwin" ? !input.meta || input.control : !input.control || input.meta)) return undefined;
  if (input.key === "+" || input.key === "=" || input.code === "NumpadAdd") return "in";
  if (input.key === "-") return "out";
  if (input.key === "0") return "reset";
  return undefined;
};

/** Own these keys before Chromium's default menu shortcuts can change zoom a second time. */
export const bindZoom = (page: ElectronContents, os: ShellPlatform): void => {
  page.setZoomFactor(Math.max(0.5, Math.min(2, page.getZoomFactor())));
  page.on("before-input-event", (event, input) => {
    const action = zoomAction(input, os);
    if (action === undefined) return;
    event.preventDefault();
    changeZoom(page, action);
  });
};
