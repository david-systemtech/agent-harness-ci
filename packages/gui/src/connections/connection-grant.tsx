import { grantWords, type EnvironmentView } from "@agent-harness/client-runtime";
import { SCOPES } from "@agent-harness/contracts";
import { useState } from "react";
import { Button } from "../ui/index.js";
import { AccessDetails } from "./limited-access.js";
import { nameOf } from "./words.js";
import "./phone-pairing.css";
/** The connection's actual grant remains readable even without access-list authority. */
export const ConnectionGrant = ({ view }: { readonly view: EnvironmentView }) => (
  <p role="note" aria-label="This client's grant" data-connection-grant className="text-sm text-ink-muted">
    This client: {view.ceiling === null ? `Scopes: ${view.scopes.join(", ")}; ceiling not yet known.` : grantWords(view.scopes, view.ceiling)} To expand it, ask a trusted client for a Custom code, then deliberately re-pair. This client cannot raise its own ceiling.
  </p>
);

/** Whether this app's pairing with `view` lacks a scope or a ceiling below the highest; a ceiling not yet known is not said to be limited. */
const limited = (view: EnvironmentView): boolean => SCOPES.some((scope) => !view.scopes.includes(scope)) || (view.ceiling !== null && view.ceiling !== "bypassPermissions");

/**
 * A limited pairing on a Set up card, in one line (setup-copy.md §5.4,
 * #1846): `This app has limited access to {name}.` with What does this mean?,
 * which opens the limited-access sheet (#1631); nothing for full access.
 */
export const LimitedGrant = ({ view }: { readonly view: EnvironmentView }) => {
  const [open, setOpen] = useState(false);
  if (!limited(view)) return null;
  return (
    <div data-limited-grant className="flex flex-wrap items-center gap-2 text-sm text-ink">
      <p>This app has limited access to {nameOf(view)}.</p>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} title="What does this mean? (Enter or Space)">What does this mean?</Button>
      <AccessDetails view={view} open={open} onOpenChange={setOpen} />
    </div>
  );
};
