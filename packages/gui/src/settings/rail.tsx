import { matchSettingsRows, rowHealth, type SetupView } from "@agent-harness/client-runtime";
import { SETTINGS_BANDS, SETTINGS_ROWS, type SettingsRowId } from "@agent-harness/contracts";
import { Brain, Bot, CalendarClock, Cpu, Gauge, GitPullRequest, Globe, Info, Keyboard, KeyRound, Laptop, ListChecks, Palette, Search, Server, Shield, Sparkles, Vault, type LucideIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { HealthDot } from "../setup/health-dot.js";
import { useSetupView } from "../setup/use-setup.js";
import { Input } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { usePickedEnvironment, useSettings } from "./settings-window.js";

/** Icons measured for the registered rows (look.md §12.1). */
const ROW_ICONS: Readonly<Record<SettingsRowId, LucideIcon>> = {
  "setup.checklist": ListChecks,
  "accounts.accounts": KeyRound, "accounts.default-model": Cpu, "accounts.usage": Gauge,
  "knowledge.banks": Brain, "knowledge.skills": Sparkles, "knowledge.instructions": Bot,
  "access.permissions": Shield, "access.browser": Globe, "access.key-managers": Vault, "access.forges": GitPullRequest,
  "routines.routines": CalendarClock, "routines.bots": Bot,
  "environments.machines": Laptop, "environments.access": KeyRound, "environments.service": Server,
  "appearance.theme": Palette, "appearance.shortcuts": Keyboard, "about.about": Info,
};

/** Why a placeholder row is drawn dim, from the registry; undefined for every other row. */
export const dimReason = (row: (typeof SETTINGS_ROWS)[number]): string | undefined => ("dim" in row ? row.dim : undefined);

/**
 * One row of the rail: its label, the open one marked, and its health dot on
 * the environment the dots follow; a placeholder dim with its reason under
 * it, opening nothing.
 */
const RailRow = ({ row, current, setup }: { readonly row: (typeof SETTINGS_ROWS)[number]; readonly current: boolean; readonly setup: SetupView | undefined }) => {
  const { open } = useSettings();
  const reasonId = useId();
  const dim = dimReason(row);
  const Icon = ROW_ICONS[row.id];
  return (
    <li className="flex flex-col">
      <button
        type="button"
        title={`${row.label} · ${row.hint}${dim === undefined ? "" : ` · ${dim}`}`}
        aria-label={row.label}
        aria-current={current ? "page" : undefined}
        aria-disabled={dim === undefined ? undefined : true}
        aria-describedby={dim === undefined ? undefined : reasonId}
        onClick={() => dim === undefined && open(row.id)}
        className={classes(
          "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-beam",
          current && "bg-wash-strong",
          dim === undefined && "hover:bg-wash",
          dim !== undefined ? "text-ink-faint hover:bg-transparent" : current ? "text-ink" : "text-ink-muted",
        )}
      >
        <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex items-center gap-1.5 text-xs font-medium"><span className="truncate">{row.label}</span><HealthDot state={setup === undefined ? null : rowHealth(setup, row.id)} of={row.label} /></span>
          <span className="truncate text-2xs text-ink-faint">{row.hint}</span>
        </span>
      </button>
      {dim !== undefined && <span id={reasonId} className="px-2.5 text-2xs text-ink-faint">{dim}</span>}
    </li>
  );
};

/**
 * The rail (docs/specs/gui.md, "Settings: the rail, the rows and the
 * addresses"; ADR 0027): search at its top, then the eight bands in order,
 * each with its rows. Search filters every row across the bands by its id,
 * label, hint and old names (`matchSettingsRows`), so "secrets" finds Key
 * managers; a band with no row found is not drawn. The health dots follow
 * the environment the last `environment` pane picked, else the home
 * environment, and show only on home rows (`rowHealth`).
 */
export const SettingsRail = ({ current, query, setQuery }: { readonly current: SettingsRowId; readonly query: string; readonly setQuery: (query: string) => void }) => {
  const found = useMemo(() => new Set(matchSettingsRows(query)), [query]);
  const setup = useSetupView(usePickedEnvironment()?.environmentId);
  return (
    <nav aria-label="Settings rows" className="flex w-[208px] shrink-0 flex-col gap-3 overflow-y-auto border-r border-hairline p-2">
      <div className="relative h-8 shrink-0">
        <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 size-4 text-ink-faint" />
        <Input title="Search settings" className="pl-8 text-xs md:text-xs" type="search" aria-label="Search settings" placeholder="Search settings" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {SETTINGS_BANDS.map((band) => {
        const inBand = SETTINGS_ROWS.filter((row) => row.band === band.id && found.has(row.id));
        if (inBand.length === 0) return null;
        return (
          <div key={band.id} className="flex flex-col gap-0.5">
            <h2 className="chrome-label px-2.5 text-ink-faint">{band.label}</h2>
            <ul className="flex flex-col gap-0.5">
              {inBand.map((row) => (
                <RailRow key={row.id} row={row} current={row.id === current} setup={setup} />
              ))}
            </ul>
          </div>
        );
      })}
      {found.size === 0 && <p className="px-2 text-sm text-ink-faint">No row matches “{query.trim()}”.</p>}
    </nav>
  );
};
