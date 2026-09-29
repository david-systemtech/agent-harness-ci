import type { EnvironmentView } from "@agent-harness/client-runtime";
import { Button } from "../ui/index.js";
import { useRuntime } from "../window-context.js";
import { useLocalService } from "./local-service.js";
import { useOpenPairing } from "./pairing.js";
import { remedyOf } from "./words.js";

/**
 * What a connection offers, as a button that runs it (docs/specs/gui.md,
 * "The local environment, pairing and updates"): Start while the local
 * service is down, Pair again for a paired connection revoked or expired,
 * Try again for a local one, whose grant is exchanged again. Nothing while
 * a start is under way; the start's absence said with its reason where the
 * shell cannot start a service.
 */
export const Remedy = ({ view, startLabel = "Start" }: { readonly view: EnvironmentView; readonly startLabel?: string }) => {
  const runtime = useRuntime();
  const service = useLocalService();
  const openPairing = useOpenPairing();
  switch (remedyOf(view)) {
    case "start":
      if (service.starting) return null;
      if (service.available.status === "absent") return <span className="text-xs text-ink-faint">{service.available.message}</span>;
      return <Button onClick={() => service.start(view.environmentId)}>{startLabel}</Button>;
    case "re-pair":
      return <Button onClick={() => openPairing({ rePair: view.environmentId })}>Pair again</Button>;
    case "retry":
      return <Button onClick={() => void runtime.connections.retryNow(view.environmentId).catch(() => undefined)}>Try again</Button>;
    case undefined:
      return null;
  }
};
