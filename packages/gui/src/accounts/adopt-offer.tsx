import { adoptAccount, ambientOffer, uuidv7 } from "@agent-harness/client-runtime";
import { useId, useMemo, useState, type FormEvent } from "react";
import { Button, Input } from "../ui/index.js";
import { useClock, useFollowed, useRuntime } from "../window-context.js";

export interface AdoptOfferProps {
  readonly environmentId: string;
  readonly environment: string;
  /** Whether this client may adopt: the environment reached, with `admin`. */
  readonly writable: boolean;
  /** Says one line in the pane: what adopting did, or why it did not. */
  readonly say: (line: string) => void;
}

/**
 * The machine's own Claude Code sign-in, offered for adopting in place (the
 * Set up specification, "Account"; claude-adapter spec, "Adopt reads nothing
 * itself"; ADR 0018; #414): `accounts.probe` from the request cache, read as
 * the pane opens and again on `account.updated`, so the offer shows while
 * the directory there is signed in and no account holds it, and goes once
 * one does. Adopt sends `accounts.adopt` with the label typed, or none for
 * the email it signs in as.
 */
export const AdoptOffer = ({ environmentId, environment, writable, say }: AdoptOfferProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const heading = useId();
  const probed = runtime.capability(environmentId, "accounts.probe").status === "present";
  const probe = useFollowed(useMemo(() => (probed ? runtime.requests.cached(environmentId, "accounts.probe", {}) : undefined), [runtime, environmentId, probed]))?.result;
  const [label, setLabel] = useState("");
  const [sending, setSending] = useState(false);
  const offer = ambientOffer(probe, environment);
  if (offer === undefined) return null;

  const adopt = (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    void adoptAccount(runtime, environmentId, label, uuidv7(clock.now()), environment).then((adopted) => {
      setSending(false);
      if (adopted.ok) setLabel("");
      say(adopted.line);
    });
  };

  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-md border border-line p-4">
      <h3 id={heading} className="text-base font-semibold text-ink">
        {offer}
      </h3>
      <form className="flex flex-wrap items-end gap-2" onSubmit={adopt}>
        <label className="flex flex-col gap-1 text-sm text-ink-muted">
          Label (the email it signs in as when empty)
          <Input value={label} disabled={!writable} onChange={(event) => setLabel(event.target.value)} className="w-64" />
        </label>
        <Button tone="primary" type="submit" disabled={!writable || sending}>
          Adopt
        </Button>
      </form>
    </section>
  );
};
