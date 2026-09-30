import type { EnvironmentHeading, EnvironmentView, FoldingHeading, HeadingRow } from "@agent-harness/client-runtime";
import { useId, type ReactNode } from "react";
import { EnvironmentDot } from "../connections/environment-badge.js";
import { EnvironmentStatus } from "../connections/environment-status.js";
import { THIS_MACHINE } from "../connections/words.js";
import { classes } from "../ui/classes.js";
import { freshnessWords } from "./words.js";

/**
 * The sidebar's headings (docs/specs/gui.md, "The window and the sidebar"),
 * each a region named by its heading over its rows: the pinned block, a
 * merged group and the shelves fold, keeping the fold by heading name
 * (`collapsedHeadings`, keyed as the terminal UI keys it), and say
 * `pending` while a command about one of their groups, or folded one about
 * a row they hide, awaits its receipt; an environment's heading does not
 * fold, and says its connection's phase with what it offers (a block's
 * action among them), since when it has not been reached, how many commands
 * wait for it, how current its list is until it is live, a list that
 * failed, and that it has no session.
 */

/** Draws a heading's rows, given which the focused pane shows. */
export type DrawRows = (rows: readonly HeadingRow[]) => ReactNode;

/** The marker a heading wears while a command about it awaits its receipt. */
const PendingWord = ({ children = "pending" }: { readonly children?: string }) => <span className="font-normal text-amber"> {children}</span>;

export const FoldingSection = ({ heading, fold, rows }: { readonly heading: FoldingHeading; fold(key: string, folded: boolean): void; readonly rows: DrawRows }) => {
  const name = useId();
  const list = useId();
  return (
    <section aria-labelledby={name} className="flex flex-col gap-0.5">
      <h2 className="flex items-center text-xs font-semibold text-ink-muted">
        <button
          type="button"
          aria-expanded={!heading.folded}
          aria-controls={heading.folded ? undefined : list}
          onClick={() => fold(heading.key, !heading.folded)}
          className="flex min-w-0 items-center gap-1 rounded-sm text-left outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-beam"
        >
          <span aria-hidden="true">{heading.folded ? "▸" : "▾"}</span> <span id={name}>{heading.text}</span>
        </button>
        {heading.folded && <span className="font-normal text-ink-faint"> {heading.block.rows.length}</span>}
        {heading.pending && <PendingWord />}
      </h2>
      {!heading.folded && (
        <ul id={list} className="flex flex-col">
          {rows(heading.rows)}
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
  const freshness = freshnessWords(heading.list);
  const fault = heading.list?.fault ?? null;
  return (
    <section aria-labelledby={name} className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <EnvironmentDot view={view} />
        <h2 id={name} className={classes("min-w-0 truncate text-xs font-semibold", heading.dim ? "text-ink-faint" : "text-ink-muted")}>
          {view.name ?? THIS_MACHINE}
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
      {heading.rows.length > 0 && <ul className="flex flex-col">{rows(heading.rows)}</ul>}
    </section>
  );
};
