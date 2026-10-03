import { adminCall, uuidv7 } from "@agent-harness/client-runtime";
import type { SkillCarryOverOffer } from "@agent-harness/contracts";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** A checkout is tracked at the offer's branch or pin, rather than copied into the own directory (ADR 0021). */
export const CheckoutOffer = ({ environmentId, offer }: { readonly environmentId: string; readonly offer: SkillCarryOverOffer }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const [busy, setBusy] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [line, say] = useState<string | undefined>(undefined);
  const writable = runtime.capability(environmentId, "skills.sources.add").status === "present";
  const track = async () => {
    setBusy(true);
    say(undefined);
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
    say(answer.ok ? `Tracking ${offer.name} as a source.` : `Not tracked: ${answer.line}`);
  };
  return (
    <section aria-label={`Skill checkout: ${offer.name}`} className="flex min-w-0 flex-col gap-2 rounded-lg border border-hairline p-3">
      <p className="text-sm text-ink">
        {offer.name}: {offer.url}, {offer.folder};{" "}
        {offer.follow.kind === "branch" ? `branch ${offer.follow.branch ?? "(default)"}` : `pinned at ${offer.follow.commit}`}.
      </p>
      <Button variant="outline" title="Track as a source · Tab, Enter or Space" className="self-start" disabled={!writable || busy || tracked} onClick={() => void track()}>
        <GitBranch aria-hidden="true" />Track as a source
      </Button>
      {line !== undefined && <p className="text-sm text-ink-muted">{line}</p>}
    </section>
  );
};
