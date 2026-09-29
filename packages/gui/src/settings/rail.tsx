import { matchSettingsRows } from "@agent-harness/client-runtime";
import { SETTINGS_BANDS, SETTINGS_ROWS, type SettingsRowId } from "@agent-harness/contracts";
import { useId, useMemo, useState } from "react";
import { Input } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useSettings } from "./settings-window.js";

/** Why a placeholder row is drawn dim, from the registry; undefined for every other row. */
export const dimReason = (row: (typeof SETTINGS_ROWS)[number]): string | undefined => ("dim" in row ? row.dim : undefined);

/** One row of the rail: its label, the open one marked; a placeholder dim with its reason under it, opening nothing. */
const RailRow = ({ row, current }: { readonly row: (typeof SETTINGS_ROWS)[number]; readonly current: boolean }) => {
  const { open } = useSettings();
  const reasonId = useId();
  const dim = dimReason(row);
  return (
    <li className="flex flex-col">
      <button
        type="button"
        aria-current={current ? "page" : undefined}
        aria-disabled={dim === undefined ? undefined : true}
        aria-describedby={dim === undefined ? undefined : reasonId}
        onClick={() => dim === undefined && open(row.id)}
        className={classes(
          "rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam",
          current ? "bg-wash-strong text-ink" : "text-ink-muted",
          dim !== undefined && "text-ink-faint hover:bg-transparent",
        )}
      >
        {row.label}
      </button>
      {dim !== undefined && (
        <span id={reasonId} className="px-2 text-xs text-ink-faint">
          {dim}
        </span>
      )}
    </li>
  );
};

/**
 * The rail (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0027): search at its top, then the eight bands in order,
 * each with its rows. Search filters every row across the bands by its id,
 * label, hint and old names (`matchSettingsRows`), so "secrets" finds Key
 * managers; a band with no row found is not drawn.
 */
export const SettingsRail = ({ current }: { readonly current: SettingsRowId }) => {
  const [query, setQuery] = useState("");
  const found = useMemo(() => new Set(matchSettingsRows(query)), [query]);
  return (
    <nav aria-label="Settings rows" className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-inset p-3">
      <Input type="search" aria-label="Search settings" placeholder="Search settings" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      {SETTINGS_BANDS.map((band) => {
        const inBand = SETTINGS_ROWS.filter((row) => row.band === band.id && found.has(row.id));
        if (inBand.length === 0) return null;
        return (
          <div key={band.id} className="flex flex-col gap-0.5">
            <h2 className="px-2 text-xs font-semibold text-ink-faint">{band.label}</h2>
            <ul className="flex flex-col gap-0.5">
              {inBand.map((row) => (
                <RailRow key={row.id} row={row} current={row.id === current} />
              ))}
            </ul>
          </div>
        );
      })}
      {found.size === 0 && <p className="px-2 text-sm text-ink-faint">No row matches “{query.trim()}”.</p>}
    </nav>
  );
};
