import { grantWords, type EnvironmentView } from "@agent-harness/client-runtime";
import "./phone-pairing.css";
/** The connection's actual grant remains readable even without access-list authority. */
export const ConnectionGrant = ({ view }: { readonly view: EnvironmentView }) => (
  <p role="note" aria-label="This client's grant" data-connection-grant className="text-sm text-ink-muted">
    This client: {view.ceiling === null ? `Scopes: ${view.scopes.join(", ")}; ceiling not yet known.` : grantWords(view.scopes, view.ceiling)} To expand it, ask a trusted client for a Custom code, then deliberately re-pair. This client cannot raise its own ceiling.
  </p>
);
