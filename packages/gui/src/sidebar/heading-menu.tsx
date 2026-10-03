import { Pencil, Trash2 } from "lucide-react";
import type { CapabilityAnswer, MergedGroupHeading } from "@agent-harness/client-runtime";
import type { CommandMethodName } from "@agent-harness/contracts";
import { ContextMenuContent } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { Entry, menuLetter, useHandOn } from "./menu-entry.js";
import { useOrganise } from "./organise.js";
import { quoted } from "./words.js";

/**
 * A merged group's context menu (docs/specs/gui.md, "The window and the
 * sidebar"; #398): Rename group, in place, and Delete group, asked once, each
 * one command per member group on its own environment (#128, the runtime's
 * `changeHeading`). Each is dim with the first member's connection that
 * cannot send it, saying why.
 */

const PRESENT: CapabilityAnswer = { status: "present" };

export interface GroupMenuProps {
  /** The heading's key, as `collapsedHeadings` keys it. */
  readonly headingKey: string;
  readonly name: string;
  readonly group: MergedGroupHeading;
  /** Turns the heading's name into a field, to rename it in place. */
  rename(): void;
}

export const GroupMenu = ({ headingKey, name, group, rename }: GroupMenuProps) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const { handOn, onCloseAutoFocus } = useHandOn();
  const offer = (method: CommandMethodName) =>
    group.groups.map((member) => runtime.commands.admits(member.environmentId, method)).find((answer) => answer.status === "absent") ?? PRESENT;
  return (
    <ContextMenuContent className="w-[192px]" onKeyDown={menuLetter} aria-label={`Organise the group ${quoted(name)}`} onCloseAutoFocus={onCloseAutoFocus}>
      <Entry icon={Pencil} letter="R" offer={offer("groups.rename")} onSelect={handOn(rename)}>
        Rename group
      </Entry>
      <Entry icon={Trash2} letter="D" offer={offer("groups.delete")} onSelect={handOn(() => organise.open({ kind: "delete-group", heading: headingKey }))}>
        Delete group…
      </Entry>
    </ContextMenuContent>
  );
};
