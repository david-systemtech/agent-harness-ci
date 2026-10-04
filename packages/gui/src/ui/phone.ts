import { useMemo, useSyncExternalStore } from "react";

/** Match the component styles' phone breakpoint, including a resize while a picker is open. */
export const usePhoneOverlay = (): boolean => {
  const query = useMemo(() => window.matchMedia("(width < 640px)"), []);
  return useSyncExternalStore(
    callback => { query.addEventListener("change", callback); return () => query.removeEventListener("change", callback); },
    () => query.matches,
  );
};
