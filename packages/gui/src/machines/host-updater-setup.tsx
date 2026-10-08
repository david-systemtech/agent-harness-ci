import { HOST_UPDATER_SETUP } from "@agent-harness/client-runtime";
import { X } from "lucide-react";
import { useId } from "react";
import { CopyLine } from "../settings/copy-line.js";
import { Button, Tooltip } from "../ui/index.js";

/**
 * How to set up the host-side updater (setup-copy.md §5.4; #1883), which
 * Your machines' How to set it up opens beside the line of a container no
 * updater has polled: where the release's two files go, each command to
 * copy, and what comes after. It reads nothing from the environment.
 */
export const HostUpdaterSetup = ({ close }: { readonly close: () => void }) => {
  const headingId = useId();
  const { heading, intro, commands, after } = HOST_UPDATER_SETUP;
  return (
    <section aria-labelledby={headingId} data-host-updater-setup className="flex flex-col gap-3 rounded-lg border border-hairline bg-panel p-3">
      <h4 id={headingId} className="text-xs font-semibold text-ink">
        {heading}
      </h4>
      <p className="text-sm text-ink-muted">{intro}</p>
      {commands.map((command) => <CopyLine key={command.text} label={command.label} text={command.text} />)}
      <p className="text-sm text-ink-muted">{after}</p>
      <div>
        <Tooltip content="Close" keys="Tab, Enter"><Button variant="outline" onClick={close}><X aria-hidden="true" />Close</Button></Tooltip>
      </div>
    </section>
  );
};
