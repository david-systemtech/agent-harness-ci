import { useMemo, useSyncExternalStore } from "react";
import { phoneLayoutMedia } from "../frame/phone-frame.js";

/** Follow the shared phone layout while a picker or request sheet is open. */
export const usePhoneOverlay = (): boolean => {
  const media = useMemo(phoneLayoutMedia, []);
  return useSyncExternalStore(
    callback => { media.forEach(query => query.addEventListener("change", callback)); return () => media.forEach(query => query.removeEventListener("change", callback)); },
    () => media.some(query => query.matches),
  );
};
