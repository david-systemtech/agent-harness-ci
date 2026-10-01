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
    <section aria-label="Sites you are developing" className="flex flex-col gap-2">
      <label>
        <input type="checkbox" checked={saved} readOnly disabled /> Sites saved this visit
      </label>
      <label htmlFor={id}>Sites you are developing</label>
      <textarea
        id={id}
        value={text}
        disabled={!writable || busy}
        onChange={(event) => {
          setTyped(event.target.value);
          setSaved(false);
        }}
        className="rounded-md border border-line bg-inset p-2 text-ink"
      />
      <p>One host per line. Optional.</p>
      <p>Loopback and private addresses count without being listed.</p>
      <Button disabled={!writable || busy} onClick={() => void save()}>
        Save sites
      </Button>
      {line !== null && <p role="status">{line}</p>}
    </section>
  );
};
