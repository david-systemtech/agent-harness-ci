import { changeHeading, type EnvironmentHeading, type EnvironmentView, type FoldingHeading, type HeadingRow, type SessionHeading } from "@agent-harness/client-runtime";
import { useId, useState, type ReactNode } from "react";
import { EnvironmentDot } from "../connections/environment-badge.js";
import { EnvironmentStatus } from "../connections/environment-status.js";
import { THIS_MACHINE } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { ContextMenu, ContextMenuTrigger } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useDropTarget } from "./drag.js";
import { GroupMenu } from "./heading-menu.js";
import { useOrganise } from "./organise.js";
import { RenameField } from "./rename-field.js";
import { freshnessWords, notDone, quoted } from "./words.js";

/**
 * The sidebar's headings (docs/specs/gui.md, "The window and the sidebar"),
 * each a region named by its heading over its rows: the pinned block, a
 * merged group, a repository and the shelves fold, keeping the fold by heading name
 * (`collapsedHeadings`, keyed as the terminal UI keys it), and say
 * `pending` while a command about one of their groups, or folded one about
 * a row they hide, awaits its receipt; an environment's heading does not
 * fold, and says its connection's phase with what it offers (a block's
 * action among them), since when it has not been reached, how many commands
 * wait for it, how current its list is until it is live, a list that
 * failed, and that it has no session; by repository, its heading says it
 * holds the sessions with no repository. Each heading takes a session dropped
 * on it (`drag.tsx`); a merged group's has a context menu that renames it,
 * in place, and deletes it (`heading-menu.tsx`).
 */

/** Draws the rows under a heading. */
export type DrawRows = (rows: readonly HeadingRow[], heading: SessionHeading) => ReactNode;

/** The longest name a group takes (`GroupName`'s 80 characters). */
const GROUP_NAME_MOST = 80;

/** The marker a heading wears while a command about it awaits its receipt. */
const PendingWord = ({ children = "pending" }: { readonly children?: string }) => <span className="font-normal text-amber"> {children}</span>;

export const FoldingSection = ({ heading, fold, rows }: { readonly heading: FoldingHeading; fold(key: string, folded: boolean): void; readonly rows: DrawRows }) => {
  const runtime = useRuntime();
  const organise = useOrganise();
  const name = useId();
  const list = useId();
  const [editing, setEditing] = useState(false);
  const target = useDropTarget({ kind: "heading", heading });
  const { group } = heading;
  const title = (
    <h2 {...target.handlers} className={classes("flex items-center rounded-sm text-xs font-semibold text-ink-muted", target.over && "bg-wash-strong")}>
      {editing && group !== null ? (
        <RenameField
          label={`Rename the group ${quoted(heading.text)}`}
          value={heading.text}
          maxLength={GROUP_NAME_MOST}
          close={() => setEditing(false)}
          commit={(renamed) => organise.hear(changeHeading(runtime.commands, group, { rename: renamed }), notDone("groups.rename"))}
        />
      ) : (
        <button
          type="button"
          aria-expanded={!heading.folded}
          aria-controls={heading.folded ? undefined : list}
          onClick={() => fold(heading.key, !heading.folded)}
          className="flex min-w-0 items-center gap-1 rounded-sm text-left outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-beam"
        >
          <span aria-hidden="true">{heading.folded ? "▸" : "▾"}</span> <span id={name}>{heading.text}</span>
        </button>
      )}
      {heading.folded && <span className="font-normal text-ink-faint"> {heading.block.rows.length}</span>}
      {heading.pending && <PendingWord />}
    </h2>
  );
  return (
    <section aria-labelledby={name} className="flex flex-col gap-0.5">
      {group === null ? (
        title
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{title}</ContextMenuTrigger>
          <GroupMenu headingKey={heading.key} name={heading.text} group={group} rename={() => setEditing(true)} />
        </ContextMenu>
      )}
      {!heading.folded && (
        <ul id={list} className="flex flex-col">
          {rows(heading.rows, heading)}
        </ul>
      )}
    </section>
  );
};

/** One line under an environment's heading. */
const Note = ({ children, tone = "text-ink-muted" }: { readonly children: string; readonly tone?: string }) => <p className={classes("text-xs", tone)}>{children}</p>;

export const EnvironmentSection = ({ heading, rows }: { readonly heading: EnvironmentHeading; readonly rows: DrawRows }) => {
  const name = useId();
  const view: EnvironmentView = heading.environment;
  const named = view.name ?? THIS_MACHINE;
  const freshness = freshnessWords(heading.list);
  const fault = heading.list?.fault ?? null;
  const target = useDropTarget({ kind: "heading", heading });
  return (
    <section aria-labelledby={name} className="flex flex-col gap-0.5">
      <div {...target.handlers} className={classes("flex items-center gap-1.5 rounded-sm", target.over && "bg-wash-strong")}>
        <EnvironmentDot view={view} />
        <h2 id={name} className={classes("min-w-0 truncate text-xs font-semibold", heading.dim ? "text-ink-faint" : "text-ink-muted")}>
          {heading.holds === "unidentified" ? `${named} · no repository` : named}
        </h2>
        {view.pendingCommands > 0 && (
          <span className="text-xs">
            <PendingWord>{`${view.pendingCommands} pending`}</PendingWord>
          </span>
        )}
      </div>
      <EnvironmentStatus view={view} />
      {freshness !== undefined && <Note tone="text-ink-faint">{freshness}</Note>}
      {fault !== null && <Note tone="text-signal">{`The list failed: ${fault}`}</Note>}
      {heading.empty && <Note tone="text-ink-faint">No sessions.</Note>}
      {heading.rows.length > 0 && <ul className="flex flex-col">{rows(heading.rows, heading)}</ul>}
    </section>
  );
};
