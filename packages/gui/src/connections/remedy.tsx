import type { EnvironmentView } from "@agent-harness/client-runtime";
import { Link, Power, RotateCw } from "lucide-react";
import { Button, Tooltip } from "../ui/index.js";
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
      return <Tooltip content={startLabel}><Button variant="default" onClick={() => service.start(view.environmentId)}><Power aria-hidden="true" />{startLabel}</Button></Tooltip>;
    case "re-pair":
      return <Tooltip content="Pair again"><Button onClick={() => openPairing({ rePair: view.environmentId })}><Link aria-hidden="true" />Pair again</Button></Tooltip>;
    case "retry":
      return <Tooltip content="Try again"><Button onClick={() => void runtime.connections.retryNow(view.environmentId).catch(() => undefined)}><RotateCw aria-hidden="true" />Try again</Button></Tooltip>;
    case undefined:
      return null;
  }
};
