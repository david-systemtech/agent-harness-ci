import { CheckCircle2, Globe, Save } from "lucide-react";
import { useId, useState } from "react";
import { useSettingsValues } from "../settings/settings-values.js";
import { Button } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/** The page policy's optional development hosts, kept on the Chrome's environment. */
export const DevelopmentSites = ({ environmentId }: { readonly environmentId: string }) => {
  const runtime = useRuntime();
  const settings = useSettingsValues(environmentId);
  const [typed, setTyped] = useState<string | null>(null);
  const [line, say] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const writable = runtime.capability(environmentId, "settings.update").status === "present" && settings.values !== null;
  const text = typed ?? (settings.values?.["browser.devSites"] as string[] | undefined)?.join("\n") ?? "";
  const save = async () => {
    setBusy(true);
    const result = await settings.save(
      "browser.devSites",
      text
        .split(/\r?\n/)
        .map((host) => host.trim())
        .filter(Boolean),
    );
    say(result.ok ? "Development sites saved." : `Sites not saved: ${result.line}`);
    if (result.ok) setSaved(true);
    setBusy(false);
  };
  return (
    <section aria-label="Sites you are developing" className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <label htmlFor={id} className="flex items-center gap-1.5 text-xs font-medium"><Globe aria-hidden="true" className="size-4" />Sites you are developing</label>
      <span className="font-mono text-2xs text-ink-faint">browser.devSites</span>
      <textarea
        id={id}
        title="Sites you are developing (Enter for a new host)"
        rows={4}
        value={text}
        disabled={!writable || busy}
        onChange={(event) => {
          setTyped(event.target.value);
          setSaved(false);
        }}
        className="min-h-32 w-full rounded-lg border border-hairline-strong bg-inset px-3 py-2.5 font-mono text-xs text-ink focus-visible:border-beam focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-beam/50 disabled:opacity-50"
      />
      <p className="text-2xs text-ink-muted">One host per line. Optional.</p>
      <p className="text-2xs text-ink-muted">Loopback and private addresses count without being listed.</p>
      <Button title="Save sites (Enter or Space)" className="self-start" variant="default" disabled={!writable || busy} onClick={() => void save()}>
        <Save aria-hidden="true" data-icon="inline-start" />Save sites
      </Button>
      {saved && <p role="status" aria-label="Sites saved this visit" className="flex items-center gap-1.5 text-2xs text-mint"><CheckCircle2 aria-hidden="true" className="size-4" />Sites saved this visit</p>}
      {line !== null && <p role="status">{line}</p>}
    </section>
  );
};
