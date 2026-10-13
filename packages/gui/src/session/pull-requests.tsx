import { PULL_REQUEST_STATE_WORDS, pullRequestNumber, pullRequestWords, shownPullRequest } from "@agent-harness/client-runtime";
import type { PullRequest, PullRequestState } from "@agent-harness/contracts";
import { GitPullRequest, GitMerge, GitPullRequestClosed } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.js";
import { Tooltip } from "../ui/tooltip.js";
import { classes } from "../ui/classes.js";
import { ExternalLink } from "./external-link.js";

/**
 * A session's pull requests where sessions are drawn (forge spec,
 * "Pull-request links and status"; docs/specs/gui.md, "The window and the
 * sidebar" and "A session pane"; #419), from the summary's `pullRequests`,
 * which the environment keeps current: a row's mark, and the caption's
 * links.
 */

/** Each state in its token: open in the good colour, merged in the accent's neighbour, closed faint. */
const STATE_ICON = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed };
const STATE_LOOK: Readonly<Record<PullRequestState, string>> = { open: "text-sage", merged: "text-cyan", closed: "text-ink-faint" };

/** A row's mark: the state of the pull request linked last, named in full; nothing for a session with none. */
export const PullRequestMark = ({ pullRequests }: { readonly pullRequests: readonly PullRequest[] }) => {
  const shown = shownPullRequest(pullRequests);
  if (shown === null) return null;
  const others = pullRequests.length - 1;
  const words = `${pullRequestWords(shown)}${others > 0 ? `, and ${String(others)} more` : ""}`;
  return (
    <>
      {" "}
      <span role="img" aria-label={words} title={words} className={classes("shrink-0 text-xs", STATE_LOOK[shown.state])}>
        PR {PULL_REQUEST_STATE_WORDS[shown.state]}
      </span>
    </>
  );
};

/** One PR's number and state, using the same external-link boundary in chips and the list. */
const PullRequestLink = ({ pullRequest }: { readonly pullRequest: PullRequest }) => {
  const number = pullRequestNumber(pullRequest.url);
  const Icon = STATE_ICON[pullRequest.state];
  return (
    <ExternalLink url={pullRequest.url} label={pullRequestWords(pullRequest)} look={classes("inline-flex max-w-full items-center gap-1 px-1 text-xs hover:bg-wash", STATE_LOOK[pullRequest.state])}>
      <Icon aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">PR{number === null ? "" : ` #${number}`} {PULL_REQUEST_STATE_WORDS[pullRequest.state]}</span>
    </ExternalLink>
  );
};

/**
 * At most two caption chips: newest linked open PRs first, then newest linked others.
 * The contract has no change timestamp. Narrow captions show only the list trigger;
 * the container query scales with text size, leaving the breadcrumb and title first.
 */
export const PullRequestLinks = ({ pullRequests }: { readonly pullRequests: readonly PullRequest[] }) => {
  if (pullRequests.length === 0) return null;
  const newest = [...pullRequests].reverse();
  const shown = [...newest.filter(pr => pr.state === "open"), ...newest.filter(pr => pr.state !== "open")].slice(0, 2);
  const others = pullRequests.length - shown.length;
  return (
    <div data-caption-pull-requests className="flex shrink-0 items-center gap-1 whitespace-nowrap">
      <div data-pr-chips className="items-center gap-1">
        {shown.map(pullRequest => (
          <Tooltip key={pullRequest.url} content={pullRequestWords(pullRequest)}><span className="inline-flex min-w-0 max-w-[8.5rem]">
            <PullRequestLink pullRequest={pullRequest} />
          </span></Tooltip>
        ))}
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" data-pr-overflow data-pr-has-others={others > 0 ? "true" : "false"}
            aria-label={`Show all ${String(pullRequests.length)} pull requests`}
            className="rounded-sm px-1 text-xs text-ink-muted outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam">
            <span data-pr-compact>{pullRequests.length} {pullRequests.length === 1 ? "PR" : "PRs"}</span>
            <span data-pr-expanded>+{others} {others === 1 ? "PR" : "PRs"}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent aria-label="Pull requests" align="end">
          <span className="text-sm font-medium text-ink">Pull requests</span>
          <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto" aria-label="All pull requests">
            {newest.map(pullRequest => <li key={pullRequest.url}><PullRequestLink pullRequest={pullRequest} /></li>)}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
};
