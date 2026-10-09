import { DENYLIST_TEST_KIND_NAMES, testDenylist, type DenylistTested } from "@agent-harness/client-runtime";
import { DENYLIST_TEST_KINDS, type DenylistTestKind } from "@agent-harness/contracts";
import { FlaskConical, ListFilter, Text } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Input, Select } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/**
 * Test the always-ask list (setup-copy.md §5.12; permissions spec, "Methods
 * on the wire"; #415): a path, a command line, a host or URL, or a browser
 * address, tested against the denylist
 * as it stands on the environment (`permissions.denylist.test`, a `read`
 * query, so a client without `admin` may test too), naming each entry it
 * matches as a denylist prompt names it, or that nothing does.
 */
export const DenylistTest = ({ environmentId, ready }: { readonly environmentId: string; readonly ready: boolean }) => {
  const runtime = useRuntime();
  const [kind, setKind] = useState<DenylistTestKind>("path");
  const [value, setValue] = useState("");
  const [tested, setTested] = useState<DenylistTested | undefined>(undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTested(undefined);
    void testDenylist(runtime, environmentId, kind, value).then(setTested);
  };
  return (
    <form aria-label="Test the always-ask list" onSubmit={submit} className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-ink"><FlaskConical aria-hidden="true" className="size-4" />Test the always-ask list</span>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><ListFilter aria-hidden="true" className="size-3.5" />Test as</span><Select title="Test as (Arrow keys to choose)" aria-label="Test as" value={kind} onChange={(event) => setKind(event.target.value as DenylistTestKind)}>
          {DENYLIST_TEST_KINDS.map((option) => (
            <option key={option} value={option}>
              {DENYLIST_TEST_KIND_NAMES[option]}
            </option>
          ))}
        </Select></label>
        <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-2xs"><span className="flex items-center gap-1.5"><Text aria-hidden="true" className="size-3.5" />Value to test</span><Input title="Value to test (Enter to test)" aria-label="Value to test" value={value} onChange={(event) => setValue(event.target.value)} className="w-full font-mono" /></label>
        <Button title="Test (Enter)" type="submit" disabled={!ready || value.trim() === ""}>
          <FlaskConical aria-hidden="true" data-icon="inline-start" />Test
        </Button>
      </div>
      {tested !== undefined &&
        (tested.ok ? (
          <ul aria-label="What it matches" className="flex flex-col gap-0.5 text-sm text-ink">
            {tested.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-signal">{tested.line}</p>
        ))}
    </form>
  );
};
