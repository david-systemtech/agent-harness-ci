import { useWindowAction } from "../keys/key-dispatch.js";
import { useShell } from "../window-context.js";

/** Native shortcuts stay in the desktop; menu and palette use the same shell member. */
export const ZoomActions = () => {
  const shell = useShell();
  const offer = shell?.window?.zoom === undefined ? { status: "absent" as const, message: "Use your browser's zoom controls." } : { status: "present" as const };
  useWindowAction("app.zoom.in", () => shell?.window?.zoom?.("in"), offer);
  useWindowAction("app.zoom.out", () => shell?.window?.zoom?.("out"), offer);
  useWindowAction("app.zoom.reset", () => shell?.window?.zoom?.("reset"), offer);
  return null;
};
