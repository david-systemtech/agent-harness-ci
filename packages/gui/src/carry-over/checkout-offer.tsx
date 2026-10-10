import { adminCall, plainRefusal, uuidv7, type PlainRefusal } from "@agent-harness/client-runtime";
import type { SkillCarryOverOffer } from "@agent-harness/contracts";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { TechnicalDetails, type TechnicalDetailsProps } from "../setup/details.js";
import { SetupNotice } from "../setup/notice.js";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** The site a checkout's remote is on: an address's host, an scp-style remote's (`git@host:path`), else the remote itself. */
const hostOf = (url: string): string => {
  try {
    const { host } = new URL(url);
    if (host !== "") return host;
  } catch {
    // Not an address: an scp-style remote, or a path.
  }
  return /^(?:[^@/]+@)?([^:/]+):/.exec(url)?.[1] ?? url;
};

/**
 * A skills folder that is a checkout, offered to be kept up to date from its
 * site at the offer's branch or pin rather than copied (ADR 0021;
 * setup-copy.md §5.3): its name and site, Keep it up to date, and its
 * address, folder and branch in Details.
 */
export const CheckoutOffer = ({ environmentId, offer, details }: { readonly environmentId: string; readonly offer: SkillCarryOverOffer; readonly details: (line: string, details: readonly string[]) => TechnicalDetailsProps }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [refused, setRefused] = useState<PlainRefusal | undefined>(undefined);
  const writable = runtime.capability(environmentId, "skills.sources.add").status === "present";
  const line = `${offer.name} is a skills folder from ${hostOf(offer.url)}.`;
  const facts = [`Address: ${offer.url}`, `Folder: ${offer.folder}`, offer.follow.kind === "branch" ? `Branch: ${offer.follow.branch ?? "(default)"}` : `Pinned at: ${offer.follow.commit}`];
  const track = async () => {
    setBusy(true);
    setRefused(undefined);
    const answer = await adminCall(() =>
      runtime.requests.call(environmentId, "skills.sources.add", {
        commandId: uuidv7(clock.now()),
        url: offer.url,
        folder: offer.folder,
        follow: offer.follow,
      }),
    );
    setBusy(false);
    if (answer.ok) setTracked(true);
    else setRefused(plainRefusal(answer.refusal, "Keep it up to date"));
  };
  return (
    <section aria-label={`Skills folder: ${offer.name}`} className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline p-3">
      <p className="text-sm text-ink">{line}</p>
      <Button variant="outline" title="Keep it up to date · Tab, Enter or Space" className="self-start" disabled={!writable || busy || tracked} onClick={() => void track()}>
        <GitBranch aria-hidden="true" />Keep it up to date
      </Button>
      {tracked && <p role="status" className="text-sm text-ink-muted">agent-harness keeps {offer.name} up to date now.</p>}
      {refused !== undefined && <SetupNotice tone="error" title={refused.line} details={details(refused.line, [...facts, ...refused.details])} />}
      {refused === undefined && <TechnicalDetails {...details(line, facts)} />}
    </section>
  );
};
