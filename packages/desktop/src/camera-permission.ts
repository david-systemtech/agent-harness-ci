import type { ElectronContents, MediaPermissionDetails } from "./electron.js";
import { isAppPage } from "./schemes.js";

/** Camera access belongs to the app's main frame; microphones, dock pages and previews get none. */
export const allowAppCamera = (app: ElectronContents): void => {
  const ownFrame = (contents: ElectronContents | null, details: MediaPermissionDetails) =>
    contents === app && details.isMainFrame && isAppPage(details.requestingUrl ?? "");
  app.session.setPermissionCheckHandler((contents, permission, origin, details) =>
    permission === "media" && ownFrame(contents, details) && isAppPage(origin) && details.mediaType === "video",
  );
  app.session.setPermissionRequestHandler((contents, permission, answer, details) => {
    answer(permission === "media" && ownFrame(contents, details) && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "video");
  });
};
