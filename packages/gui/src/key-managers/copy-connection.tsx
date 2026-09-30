import { copyLine } from "@agent-harness/client-runtime";
import type { KeyManagerConnectionRecord } from "@agent-harness/contracts";
import { CopyDialog } from "../settings/copy-dialog.js";
import { useRuntime } from "../window-context.js";

export interface CopyConnectionProps {
  readonly environmentId: string;
  readonly connection: KeyManagerConnectionRecord;
  readonly close: () => void;
}

/**
 * Copy to other environments (ADR 0028's "same on every environment"; the
 * key-managers spec, "Copies and the state import"; #384, #425): the copy
 * dialog sending `runtime.keyManagers.copy`, which adds the connection on
 * each environment ticked without its credential, so each asks for it once.
 */
export const CopyConnection = ({ environmentId, connection, close }: CopyConnectionProps) => {
  const runtime = useRuntime();
  return (
    <CopyDialog
      environmentId={environmentId}
      title={`Copy ${connection.label} to other environments`}
      description="Each gets its address, CA, sign-in method, ticks and base path, without its credential: sign it in there once."
      close={close}
      copy={(to) => runtime.keyManagers.copy(environmentId, connection, to)}
      line={copyLine}
    />
  );
};
