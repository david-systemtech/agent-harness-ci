import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import { ActionButton as Button } from "../key-managers/action-button.js";
import { useChecklist } from "../setup/checklist-window.js";
import { useSettings } from "../settings/settings-window.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * Keep this token in your key manager (setup-copy.md §5.6; #590): shown on a
 * stored token only while the environment has a key manager signed in, as
 * `keyManagers.list` from the request cache holds it, and opening the Key
 * manager step's Move stored tokens on that environment.
 */
export const KeepInKeyManager = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const { pick } = useSettings();
  const { open } = useChecklist();
  const listed = useObservable(useMemo(() => runtime.requests.cached(environmentId, "keyManagers.list", {}), [runtime, environmentId]));
  const connected = listed.result?.connections.some((connection) => connection.status.kind === "signed-in") ?? false;
  if (!connected) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        icon={ArrowRight}
        label="Keep this token in your key manager"
        onClick={() => {
          pick(environmentId);
          open("key-manager", "move-stored-tokens");
        }}
      >
        Keep this token in your key manager
      </Button>
    </div>
  );
};
