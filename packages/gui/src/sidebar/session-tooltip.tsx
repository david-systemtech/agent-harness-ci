import { Tooltip as RadixTooltip } from "radix-ui";
import type { ReactElement, ReactNode } from "react";
import type { HeadingRow } from "@agent-harness/client-runtime";
import { activityWords } from "./words.js";

/** Known summary facts only; a missing latest-run account never invents attribution. */
export const SessionTooltip = ({ line, environment, account }: { readonly line: HeadingRow; readonly environment: string; readonly account: string | undefined }) => {
  const { summary } = line.row;
  const facts = [
    ["Directory", summary.workspace.path],
    ...("branch" in summary.workspace ? [["Branch", summary.workspace.branch]] : []),
    ["Environment", environment],
    ["Account", account ?? (summary.accountId === null ? "Account not recorded" : "Account unavailable")],
    ...(summary.model === null ? [] : [["Model", summary.model]]),
    ["Activity", activityWords(line.activity) ?? "Idle"],
    ...(line.wake === null ? [] : [["Wake", line.wake]]),
    ...(line.dim ? [["Connection", `Cached: ${environment} is not answering.`]] : []),
    ...(line.pending ? [["Receipt", "Sent; waiting for the environment's receipt."]] : []),
  ];
  return <div className="flex min-w-0 flex-col gap-2">
    <p className="text-xs font-medium [overflow-wrap:anywhere]">{summary.title.replace(/\s+/g, " ").slice(0, 280)}</p>
    {line.activity.state === "running" && <p className="text-cyan">Running now</p>}
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-hairline pt-2 text-2xs">
      {facts.map(([term, value]) => <div key={term} className="contents"><dt className="text-ink-faint">{term}</dt><dd className="font-mono [overflow-wrap:anywhere]">{value}</dd></div>)}
    </dl>
    <p className="text-ink-faint">Enter to open · Shift+F10 for actions</p>
  </div>;
};

/** Account records have no colour field: choose a stable swatch from semantic tokens. */
export const accountSwatch = (id: string): string => {
  const colours = ["bg-cyan", "bg-sage", "bg-amber", "bg-mint", "bg-beam-text"];
  const index = Array.from(id).reduce((sum, character) => sum + character.charCodeAt(0), 0) % colours.length;
  return colours[index] ?? "bg-cyan";
};

export const sessionAge = (at: string, now: Date): string => {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(at)) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
};

/** Sidebar facts open to the right, using the window's shared tooltip timing. */
export const RowTooltip = ({ content, children }: { readonly content: ReactNode; readonly children: ReactElement }) => (
  <RadixTooltip.Root>
    <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
    <RadixTooltip.Portal>
      <RadixTooltip.Content side="right" sideOffset={6} collisionPadding={8} className="z-50 max-w-72 rounded-md border border-hairline-strong bg-float px-2.5 py-1.5 text-xs leading-snug text-ink [overflow-wrap:anywhere] shadow-lg shadow-scrim/40 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 duration-100 motion-reduce:animate-none">
        {content}
      </RadixTooltip.Content>
    </RadixTooltip.Portal>
  </RadixTooltip.Root>
);
