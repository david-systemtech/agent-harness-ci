import type { EnvironmentView, HeadingRow, RowActivity } from "@agent-harness/client-runtime";
import { EnvironmentDot } from "../connections/environment-badge.js";
import { THIS_MACHINE } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { activityWords } from "./words.js";

/**
 * A row of the sidebar (docs/specs/gui.md, "The window and the sidebar"):
 * the environment's badge, the title, the tags, a snoozed session's wake
 * time, the activity with the parked count, and the pending marker while a
 * command about it awaits its receipt (`awaitingReceipt`). A row of an
 * environment that cannot be reached is the cached snapshot's, dim, and
 * says so. Clicking it opens the session in the focused pane; the one open
 * there is marked current.
 */

/** The activity's mark: a dot while starting or running, the parked count in the warning's colour; nothing while idle. */
const ActivityMark = ({ activity }: { readonly activity: RowActivity }) => {
  const words = activityWords(activity);
  if (words === undefined) return null;
  if (activity.state === "parked") {
    return (
      <span role="img" aria-label={words} className="shrink-0 rounded-sm px-1 text-xs font-semibold text-amber">
        ?{activity.parked > 0 ? activity.parked : ""}
      </span>
    );
  }
  return <span role="img" aria-label={words} className={classes("size-2 shrink-0 rounded-full", activity.state === "running" ? "bg-sage" : "border border-cyan")} />;
};

export interface SessionRowProps {
  readonly line: HeadingRow;
  readonly environment: EnvironmentView | undefined;
  /** It is the session the focused pane shows. */
  readonly current: boolean;
  open(): void;
}

export const SessionRowView = ({ line, environment, current, open }: SessionRowProps) => {
  const { summary } = line.row;
  const name = environment?.name ?? THIS_MACHINE;
  return (
    <li>
      <button
        type="button"
        onClick={open}
        aria-current={current ? "true" : undefined}
        title={line.dim ? `Cached: ${name} is not answering.` : undefined}
        className={classes(
          "flex w-full min-w-0 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left text-sm outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
          line.dim ? "text-ink-faint" : "text-ink",
          current && "bg-wash-strong",
        )}
      >
        <EnvironmentDot view={environment} label={name} />{" "}
        <span className="min-w-0 flex-1 truncate">{summary.title}</span>
        {summary.tags.map((tag) => (
          <span key={tag} className="shrink-0 text-xs text-ink-faint">
            {" "}#{tag}
          </span>
        ))}
        {line.wake !== null && <span className="shrink-0 text-xs text-ink-muted"> {line.wake}</span>}
        {line.activity.state === "parked" && " "}
        <ActivityMark activity={line.activity} />
        {line.pending && (
          <span role="img" aria-label="Pending" title="Sent; waiting for the environment's receipt." className="shrink-0 text-amber">
            {" "}↻
          </span>
        )}
      </button>
    </li>
  );
};
