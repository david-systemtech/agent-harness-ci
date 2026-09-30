import { DENYLIST_TEST_KIND_NAMES, testDenylist, type DenylistTested } from "@agent-harness/client-runtime";
import { DENYLIST_TEST_KINDS, type DenylistTestKind } from "@agent-harness/contracts";
import { useState, type FormEvent } from "react";
import { Button, Input, Select } from "../ui/index.js";
import { useRuntime } from "../window-context.js";

/**
 * Test (permissions spec, "Methods on the wire"; #415): a path, a command
 * line, a host or URL, or a browser address, tested against the denylist
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
    <form aria-label="Test the denylist" onSubmit={submit} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <span className="text-sm font-semibold text-ink">Test the denylist</span>
      <div className="flex items-center gap-2">
        <Select aria-label="Test as" value={kind} onChange={(event) => setKind(event.target.value as DenylistTestKind)}>
          {DENYLIST_TEST_KINDS.map((option) => (
            <option key={option} value={option}>
              {DENYLIST_TEST_KIND_NAMES[option]}
            </option>
          ))}
        </Select>
        <Input aria-label="Value to test" value={value} onChange={(event) => setValue(event.target.value)} className="min-w-0 flex-1 font-mono" />
        <Button type="submit" disabled={!ready || value.trim() === ""}>
          Test
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
