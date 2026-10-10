import type { DropTarget, EnvironmentView, HeadingRow, RowActivity } from "@agent-harness/client-runtime";
import { useMemo, useRef, useState } from "react";
import { Ellipsis, GitBranch, LoaderCircle } from "lucide-react";
import { usePhoneFrame } from "../frame/phone-frame.js";
import { useObservable, useRuntime } from "../window-context.js";
import { SessionTooltip, RowTooltip, accountSwatch, sessionAge } from "./session-tooltip.js";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { THIS_MACHINE } from "../connections/words.js";
import { PullRequestMark } from "../session/pull-requests.js";
import { classes } from "../ui/classes.js";
import { ContextMenu, ContextMenuTrigger, IconButton } from "../ui/index.js";
import { useDragRow, useDropTarget } from "./drag.js";
import { useOrganise } from "./organise.js";
import { RenameField } from "./rename-field.js";
import { contextMenuKeys, openContextActions } from "./menu-entry.js";
import { RowMenu } from "./row-menu.js";
import { activityWords, quoted } from "./words.js";

/**
 * A row of the sidebar (docs/specs/gui.md, "The window and the sidebar"):
 * the environment's badge, the title, the tags, a snoozed session's wake
 * time, the state of its pull request (the one linked last, #419), the
 * activity with the parked count, and the pending marker while a
 * command about it awaits its receipt (`awaitingReceipt`). A row of an
 * environment that cannot be reached is the cached snapshot's, dim, and
 * says so. Clicking it opens the session in the focused pane; the one open
 * there is marked current. Its context menu organises it (`row-menu.tsx`),
 * Rename turning its title into a field in place; it drags its session, and
 * takes a dragged one dropped on it (`drag.tsx`).
 */

/** Six-pixel semantic dots, with waiting taking precedence in the runtime's activity resolver. */
const ActivityMark = ({ activity }: { readonly activity: RowActivity }) => {
  const words = activityWords(activity);
  if (words === undefined) return null;
  return <span role="img" aria-label={words} className={classes("size-1.5 shrink-0 rounded-full", activity.state === "parked" ? "bg-amber" : "bg-cyan", activity.state === "running" && "motion-safe:animate-pulse")} />;
};

export interface SessionRowProps {
  readonly line: HeadingRow;
  readonly environment: EnvironmentView | undefined;
  /** It is the session the focused pane shows. */
  readonly current: boolean;
  /** Where a session dropped on it goes: its place in its heading's block, or the filtered list. */
  readonly drop: DropTarget;
  open(): void;
}

/** The longest title a session takes (`UserTitle`'s 200 characters). */
export const TITLE_MOST = 200;

export const SessionRowView = ({ line, environment, current, drop, open }: SessionRowProps) => {
  const { narrow } = usePhoneFrame();
  const trigger = useRef<HTMLButtonElement>(null);
  const { row } = line;
  const { summary } = row;
  const runtime = useRuntime();
  const accounts = useObservable(useMemo(() => runtime.projections.accounts(row.environmentId), [runtime, row.environmentId]));
  const account = accounts.value?.find((held) => held.id === summary.accountId);
  const age = sessionAge(summary.lastActivityAt ?? summary.updatedAt, runtime.environmentNow(row.environmentId));
  const name = environment?.name ?? THIS_MACHINE;
  const organise = useOrganise();
  const [editing, setEditing] = useState(false);
  const dragging = useDragRow(row);
  const target = useDropTarget(drop);
  // The 50px button holds an 18px title, 1rem metadata and a 0.125rem gap.
  // Cap scaled padding at half the remaining height; neither line may shrink.
  return (
    <li data-sidebar-item {...target.handlers} className={classes("relative h-[54px] shrink-0 px-2 py-[2px]", narrow && "flex min-w-0 items-center", target.over && "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-beam")}>
      {editing ? (
        <RenameField
          label={`Rename ${quoted(summary.title)}`}
          value={summary.title}
          maxLength={TITLE_MOST}
          close={() => setEditing(false)}
          commit={(title) => organise.send(row.environmentId, "sessions.rename", { sessionId: summary.id, title })}
        />
      ) : (
        <ContextMenu>
          <RowTooltip content={<SessionTooltip line={line} environment={name} account={account?.label} />}>
            <ContextMenuTrigger asChild>
              <button
                ref={trigger}
                type="button"
                onClick={open}
                onKeyDown={contextMenuKeys}
                {...dragging}
                data-sidebar-row
                aria-label={[name, summary.title, ...summary.tags.map((tag) => `#${tag}`), line.wake, activityWords(line.activity), line.pending ? "Pending" : null].filter(Boolean).join(" ")}
                aria-current={current ? "true" : undefined}
                title={line.dim ? `Cached: ${name} is not answering.` : undefined}
                className={classes(
                  "flex h-full w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-md px-2 py-[min(0.375rem,calc((50px-18px-1.125rem)/2))] text-left font-normal outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
                  narrow && "flex-1",
                  line.dim ? "text-ink-faint" : "text-ink",
                  current && "bg-wash-strong",
                  summary.archivedAt !== null && "opacity-60",
                )}
              >
                <span className="flex w-full min-w-0 shrink-0 items-center gap-1.5 text-xs leading-[18px]">
                  <ActivityMark activity={line.activity} />
                  <span data-sidebar-title className="min-w-0 flex-1 truncate">{summary.title}</span>
                  <span className="ml-auto shrink-0 pl-1 font-mono text-2xs leading-[18px] text-ink-faint">{age}</span>
                </span>
                <span data-sidebar-details className="flex w-full min-w-0 shrink-0 items-center gap-1.5 overflow-hidden font-mono text-2xs text-ink-faint">
                  {"branch" in summary.workspace && <span className="flex min-w-0 items-center gap-1"><GitBranch aria-hidden="true" className="size-2.5 shrink-0" /><span className="truncate">{summary.workspace.branch}</span></span>}
                  <EnvironmentGlyph view={environment} label={name} />
                  {account !== undefined && <span className="flex min-w-0 items-center gap-1"><span aria-hidden="true" className={classes("size-2 shrink-0 rounded-[3px]", accountSwatch(account.id))} /><span className="max-w-[176px] truncate">{account.label}</span></span>}
                  {summary.tags.map((tag) => <span key={tag} data-sidebar-tag className="shrink-0">#{tag}</span>)}
                  {line.wake !== null && <span data-sidebar-wake className="shrink-0 text-ink-muted">{line.wake}</span>}
                  {line.activity.state === "parked" && line.activity.parked > 0 && <span data-sidebar-waiting className="shrink-0 text-amber">{line.activity.parked}</span>}
                  <PullRequestMark pullRequests={summary.pullRequests} />
                  {line.pending && <LoaderCircle role="img" aria-label="Pending" className="size-3 shrink-0 text-amber motion-safe:animate-spin" />}
                </span>
              </button>
            </ContextMenuTrigger>
          </RowTooltip>
          {narrow && <IconButton label={`Actions for ${quoted(summary.title)}`} onClick={() => openContextActions(trigger.current)}><Ellipsis aria-hidden="true" /></IconButton>}
          <RowMenu line={line} rename={() => setEditing(true)} />
        </ContextMenu>
      )}
    </li>
  );
};
