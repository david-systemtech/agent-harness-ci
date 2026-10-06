import type { EnvironmentView } from "@agent-harness/client-runtime";
import type { OrientationRow } from "@agent-harness/contracts";
import { Lock, Power } from "lucide-react";
import { useState } from "react";
import { Part } from "../settings/part.js";
import { useSettingsValues } from "../settings/settings-values.js";
import { Switch, Tooltip, Fold } from "../ui/index.js";
import { Markdown } from "../transcript/markdown.js";
import { useRuntime } from "../window-context.js";
import { InstructionAccounts } from "./instruction-accounts.js";

/** Rendered facts are read-only; only the environment's Orientation switch is writable. */
export const Orientation = ({ view, row }: { readonly view: EnvironmentView; readonly row: OrientationRow }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(view.environmentId);
  const [line, say] = useState<string | undefined>(undefined);
  const [facts, setFacts] = useState(false);
  const [sending, setSending] = useState(false);
  const offer = runtime.capability(view.environmentId, "settings.update");
  const on = settings.values?.["instructions.orientation"];
  const save = async (enabled: boolean) => {
    say(undefined);
    setSending(true);
    try {
      const answer = await settings.save("instructions.orientation", enabled);
      if (!answer.ok) say(`Not saved: ${answer.line}`);
    } finally {
      setSending(false);
    }
  };
  return (
    <Part title="Orientation">
      <label className="flex items-center gap-2 text-sm text-ink">
        <Tooltip content="Orientation enabled" keys="Space"><Switch
          aria-label="Orientation enabled"
          checked={typeof on === "boolean" ? on : row.enabled}
          disabled={sending || offer.status === "absent" || settings.values === null}
          onCheckedChange={(enabled) => void save(enabled)}
        /></Tooltip>
        <Power aria-hidden="true" className="size-3.5" />Orientation enabled
        <span className="flex items-center gap-1 rounded-md border border-hairline px-1 text-2xs text-ink-muted"><Lock aria-hidden="true" className="size-3" />Built-in</span>
      </label>
      <p className="text-sm text-ink-muted">Turning Orientation off means the model will not know where its forges, keys and banks are.</p>
      {offer.status === "absent" && <p className="text-xs text-ink-faint">{offer.message}</p>}
      <div className="text-sm leading-[1.6]"><Markdown text={row.text ?? "No account is held on this environment."} /></div>
      {row.unreadRegistries.length > 0 && <p className="text-sm text-amber">Could not read: {row.unreadRegistries.join(", ")}.</p>}
      <Fold summary="Source and accounts" open={facts} onOpenChange={setFacts}>
        <p className="text-2xs text-ink-faint">Built from this environment's connected tools and memory banks at the start of a run.</p>
        <InstructionAccounts accounts={row.accounts} />
      </Fold>
      {line !== undefined && (
        <p role="status" className="text-sm text-signal">
          {line}
        </p>
      )}
    </Part>
  );
};
