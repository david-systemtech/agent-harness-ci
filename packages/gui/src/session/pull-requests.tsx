import { PULL_REQUEST_STATE_WORDS, pullRequestNumber, pullRequestWords, shownPullRequest } from "@agent-harness/client-runtime";
import type { PullRequest, PullRequestState } from "@agent-harness/contracts";
import { GitPullRequest, GitMerge, GitPullRequestClosed } from "lucide-react";
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

/** The caption's links: each pull request by its number and state, named in full and opened in the OS's browser. */
export const PullRequestLinks = ({ pullRequests }: { readonly pullRequests: readonly PullRequest[] }) => (
  <>
    {pullRequests.map((pullRequest) => {
      const number = pullRequestNumber(pullRequest.url);
      const Icon = STATE_ICON[pullRequest.state];
      return (
        <Tooltip key={pullRequest.url} content={pullRequestWords(pullRequest)}><span className="inline-flex shrink-0">
        <ExternalLink key={pullRequest.url} url={pullRequest.url} label={pullRequestWords(pullRequest)} look={classes("inline-flex items-center gap-1 shrink-0 px-1 text-xs hover:bg-wash", STATE_LOOK[pullRequest.state])}>
          <Icon aria-hidden="true" className="size-3" />PR{number === null ? "" : ` #${number}`} {PULL_REQUEST_STATE_WORDS[pullRequest.state]}
        </ExternalLink></span></Tooltip>
      );
    })}
  </>
);
