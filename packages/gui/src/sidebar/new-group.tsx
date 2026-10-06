import { uuidv4 } from "@agent-harness/client-runtime";
import { Check, FolderPlus, X } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, DialogClose, DialogContent, IconButton, Input, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useOrganise } from "./organise.js";

/** Creates an empty group on the focused environment, or the primary environment with no session focused. */
export const SidebarNewGroup = ({ environmentId }: { readonly environmentId: string | undefined }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const [shown, setShown] = useState(false);
  const [typed, setTyped] = useState("");
  const offer = environmentId === undefined ? { status: "absent" as const, message: "Connect to an environment first." } : runtime.commands.admits(environmentId, "groups.create");
  const name = typed.trim();
  return (
    <>
      <IconButton label="New group" size="icon-xs" {...(offer.status === "absent" && { disabledReason: offer.message })} onClick={() => { setTyped(""); setShown(true); }}><FolderPlus aria-hidden="true" /></IconButton>
      <Dialog open={shown} onOpenChange={setShown}>
        <DialogContent title="New group" description="Create a group on the focused environment, or the primary environment when no session is open.">
          <form className="flex flex-col gap-3" onSubmit={(event) => {
            event.preventDefault();
            if (environmentId === undefined || name === "" || offer.status === "absent") return;
            organise.send(environmentId, "groups.create", { id: uuidv4(), name });
            setShown(false);
          }}>
            <Input aria-label="The group's name" maxLength={80} value={typed} onChange={(event) => setTyped(event.target.value)} />
            <div className="flex justify-end gap-2">
              <Tooltip content="Cancel" keys="Esc"><DialogClose asChild><Button><X aria-hidden="true" />Cancel</Button></DialogClose></Tooltip>
              <Tooltip content="Create group" keys="Enter"><Button type="submit" variant="default" disabled={name === "" || offer.status === "absent"}><Check aria-hidden="true" />Create group</Button></Tooltip>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
};
