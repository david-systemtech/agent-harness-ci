import { changeHeading, type EnvironmentHeading, type EnvironmentView, type FoldingHeading, type HeadingRow, type SessionHeading } from "@agent-harness/client-runtime";
import { Archive, Check, Ellipsis, ChevronDown, Clock, Folder, Inbox, Layers, Pin, Plus } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { EnvironmentStatus } from "../connections/environment-status.js";
import { THIS_MACHINE } from "../connections/words.js";
import { NewSessionButton } from "../new-session/control.js";
import { classes } from "../ui/classes.js";
import { ContextMenu, ContextMenuTrigger, IconButton, Tooltip } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useDropTarget } from "./drag.js";
import { contextMenuKeys, openContextActions } from "./menu-entry.js";
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
 * in place, and deletes it (`heading-menu.tsx`); an environment's has its
 * New session control, carrying the environment (#420).
 */

/** Draws the rows under a heading. */
export type DrawRows = (rows: readonly HeadingRow[], heading: SessionHeading) => ReactNode;

/** The longest name a group takes (`GroupName`'s 80 characters). */
const GROUP_NAME_MOST = 80;

// eslint-disable-next-line agent-harness/no-client-organisation-state -- Icon lookup for projection heading kinds; no stored organisation state.
const HEADING_ICON = { pinned: Pin, group: Layers, repository: Folder, snoozed: Clock, settled: Check, archive: Archive };

/** The marker a heading wears while a command about it awaits its receipt. */
const PendingWord = ({ children = "pending" }: { readonly children?: string }) => <span className="font-normal text-amber"> {children}</span>;

export const FoldingSection = ({ heading, fold, rows }: { readonly heading: FoldingHeading; fold(key: string, folded: boolean): void; readonly rows: DrawRows }) => {
  const { narrow } = usePhoneFrame();
  const trigger = useRef<HTMLHeadingElement>(null);
  const runtime = useRuntime();
  const organise = useOrganise();
  const name = useId();
  const list = useId();
  const [editing, setEditing] = useState(false);
  const target = useDropTarget({ kind: "heading", heading });
  const { group } = heading;
  const Icon = HEADING_ICON[heading.kind];
  const count = heading.block.rows.length;
  const title = (
    <h2 ref={trigger} {...target.handlers} onKeyDown={group === null ? undefined : contextMenuKeys} className={classes("relative flex h-[24px] shrink-0 items-center gap-1 rounded-sm text-ink-muted", target.over && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-beam")}>
      {editing && group !== null ? (
        <RenameField
          label={`Rename the group ${quoted(heading.text)}`}
          value={heading.text}
          maxLength={GROUP_NAME_MOST}
          close={() => setEditing(false)}
          commit={(renamed) => organise.hear(changeHeading(runtime.commands, group, { rename: renamed }), notDone("groups.rename"))}
        />
      ) : (
        <Tooltip content={`${heading.repository ?? heading.text} · ${count} ${count === 1 ? "session" : "sessions"}`} keys={`Enter or Space to ${heading.folded ? "expand" : "collapse"}${group === null ? "" : " · Shift+F10 for actions"}`}>
          <button
            type="button"
            aria-label={heading.text}
            aria-expanded={!heading.folded}
            aria-controls={heading.folded ? undefined : list}
            onClick={() => fold(heading.key, !heading.folded)}
            className="chrome-label flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-beam"
          >
            <ChevronDown aria-hidden="true" className={classes("size-2.5 shrink-0 transition-transform duration-100 motion-reduce:transition-none", heading.folded && "-rotate-90")} />
            <Icon aria-hidden="true" className={classes("size-2.5 shrink-0", heading.kind === "archive" ? "text-ink-faint" : "text-beam-text")} />
            <span id={name} className="truncate">{heading.text}</span>
          </button>
        </Tooltip>
      )}
      <span className="ml-auto shrink-0 font-mono text-2xs font-normal tabular-nums text-ink-faint"> {count}</span>
      {heading.pending && <PendingWord />}
      {narrow && group !== null && !editing && <IconButton label={`Actions for group ${quoted(heading.text)}`} onClick={() => openContextActions(trigger.current)}><Ellipsis aria-hidden="true" /></IconButton>}
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
      <div {...target.handlers} className={classes("relative flex h-[24px] shrink-0 items-center gap-1.5 rounded-sm", target.over && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-beam")}>
        <EnvironmentGlyph view={view} />
        <Tooltip content={`${named} · ${heading.block.rows.length} ${heading.block.rows.length === 1 ? "session" : "sessions"}${heading.holds === "unidentified" ? " · No repository" : ""}`}>
          <h2 tabIndex={0} id={name} className={classes("chrome-label flex h-[24px] min-w-0 items-center outline-none focus-visible:outline-2 focus-visible:outline-beam", heading.dim ? "text-ink-faint" : "text-ink-muted")}>
            <span className="min-w-0 truncate">{heading.holds === "unidentified" ? `${named} · no repository` : named}</span>
          </h2>
        </Tooltip>
        <span className="ml-auto shrink-0 font-mono text-2xs tabular-nums text-ink-faint">{heading.block.rows.length}</span>
        {view.pendingCommands > 0 && (
          <span className="text-xs">
            <PendingWord>{`${view.pendingCommands} pending`}</PendingWord>
          </span>
        )}
        <Tooltip content={`New session on ${named}`} keys="Enter or Space">
          <NewSessionButton control={{ environmentId: view.environmentId }} label={`New session on ${named}`} className="size-6 shrink-0 p-0 text-ink-muted">
            <Plus aria-hidden="true" className="size-3" />
          </NewSessionButton>
        </Tooltip>
      </div>
      <EnvironmentStatus view={view} />
      {freshness !== undefined && <Note tone="text-ink-faint">{freshness}</Note>}
      {fault !== null && <Note tone="text-signal">{`The list failed: ${fault}`}</Note>}
      {heading.empty && ((heading.list?.freshness === "empty" || heading.list?.freshness === "catching-up") && heading.list.fault === null && (view.phase === "ready" || view.phase === "connecting" || view.phase === "syncing") ? (
        <div role="status" aria-label={`Loading sessions on ${named}`} className="flex flex-col gap-3 py-3">
          {[0, 1, 2].map((pair) => <div key={pair} className="flex flex-col gap-2 motion-safe:animate-pulse"><span className="h-3 w-3/4 rounded-sm bg-wash-strong" /><span className="h-2 w-1/2 rounded-sm bg-wash" /></div>)}
        </div>
      ) : (
        <div data-sidebar-empty className="flex flex-col items-center gap-2 px-2 py-8 text-center text-2xs text-ink-faint">
          <Inbox aria-hidden="true" className="size-7 rounded-md bg-wash p-1.5" />
          <p className="text-xs text-ink-muted">No sessions yet</p>
          <p>Every session you start on this environment shows up here.</p>
        </div>
      ))}
      {heading.rows.length > 0 && <ul className="flex flex-col">{rows(heading.rows, heading)}</ul>}
    </section>
  );
};
