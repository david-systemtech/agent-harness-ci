import type { ModeSet } from "@agent-harness/client-runtime";
import { usePaneLine } from "../session/pane-line.js";
import { toast } from "../ui/toaster.js";

/** The mode notice's toast id, which each mode set says over. */
const MODE_NOTICE = "mode-set";

/**
 * Says what setting the session's mode said (#1823). A mode got as asked is
 * said once, in the transient lane (bypassPermissions as a warning, with its
 * sentence), since the mode control shows the mode from then on, its
 * sentence in the control's tooltip; whatever the pane's line said before
 * is cleared, an earlier clamp's line no longer true. A clamp or a refusal
 * is the pane's line, under the composer. One mode notice at a time, as the
 * grid's refusal toast is: a later set replaces it, and a clamp or a refusal
 * takes it away.
 */
export const useSayModeSet = (): ((set: ModeSet) => void) => {
  const [, say] = usePaneLine();
  return (set) => {
    if (!set.transient) {
      toast.dismiss(MODE_NOTICE);
      return say(set.line);
    }
    say(undefined);
    if (set.mode === "bypassPermissions") toast.warning(set.line, { id: MODE_NOTICE });
    else toast.info(set.line, { id: MODE_NOTICE });
  };
};
