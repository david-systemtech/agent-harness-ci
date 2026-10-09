import {
  DENYLIST_SECTIONS,
  PRODUCT_NAME,
  type ContainmentLevel,
  type ContainmentReport,
  type Denylist,
  type DenylistSection,
  type ReasonTime,
  type SetupAction,
  type SetupTarget,
} from "@agent-harness/contracts";
import { parseActor } from "../event-log/event-log.js";
import type { Finding } from "../setup/check.js";
import { unenforceable } from "./containment.js";

/**
 * The Permissions step's state checks (permissions spec, "The Permissions
 * step"; ADR 0031; #141), as pure functions over what the environment
 * holds: the containment default against the probe's report, the denylist
 * against its presets, and not-root. Each answers `true` when it holds, else
 * the one line that says what does not. `setup.check` runs them
 * (`setup/check.ts`); the Your machines step's line reads the same not-root.
 */

/**
 * A state check's answer: it holds (optionally with its own line), is pending a scheduled read, or the sentence saying what does not
 * and, where its actions apply to particular items, those items, each with
 * the action it serves (#568): the accounts Sign in again opens, the
 * sources Pull now pulls. A target for an action the check does not offer
 * is not carried. A past time the sentence names is given beside it too,
 * with the words that say it, for a client to word its own way (#1742).
 */
export type StateCheckAnswer =
  | true
  | { readonly holds: true; readonly reason: string; readonly details?: readonly string[]; readonly pending?: never; readonly targets?: never; readonly times?: never; readonly actions?: never }
  | {
      readonly holds?: false;
      readonly reason: string;
      /** The raw facts behind the reason, for Details (setup-copy.md §3). */
      readonly details?: readonly string[];
      readonly pending?: true;
      readonly targets?: readonly SetupTarget[];
      readonly times?: readonly ReasonTime[];
      /** The actions this failure offers, of those its check declares; absent, all of them. */
      readonly actions?: readonly SetupAction[];
    };

/** What the step says of a sandbox this computer cannot give (setup-copy.md §5.12); how to fix it is the client's, from the cause. */
const SANDBOX_UNAVAILABLE = "The sandbox you chose does not work on this computer yet.";

/**
 * The containment default holds when this environment can enforce it; `off`
 * always can. A default that was set on a start whose probe allowed it and
 * that a later start's probe refuses (bubblewrap removed, the kernel
 * changed) does not: the line says so in plain words and offers Turn the
 * sandbox off, and details hold the level, the probe's reason, its cause
 * (which a client reads for How to fix it) and what the failing command
 * printed.
 */
export const containmentDefaultHolds = (level: ContainmentLevel, report: ContainmentReport): StateCheckAnswer => {
  const why = unenforceable(report, level);
  if (why === null) return true;
  return {
    reason: SANDBOX_UNAVAILABLE,
    details: [`permissions.containment.default: ${level}`, `Probe: ${why.reason}`, `Cause: ${why.cause}`, ...(why.detail === undefined ? [] : [`What it printed: ${why.detail}`])],
    actions: ["turn-sandbox-off"],
  };
};

/** The denylist as the check reads it: each section, and the actor of the latest change to it (null for a section never recorded). */
export interface DenylistState {
  readonly denylist: Denylist;
  readonly changedBy: Readonly<Record<DenylistSection, string | null>>;
}

/** How a section is named in a sentence. */
const SECTION_NAMES: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "browser domains",
  paths: "paths",
  commandPatterns: "command patterns",
  hosts: "hosts",
};

/** How many missing presets a line names before it counts the rest. */
const NAMED = 3;

/** Whether an actor is a person: a client session, as every change through `permissions.denylist.*` is. */
const byPerson = (actor: string | null): boolean => actor !== null && parseActor(actor).kind === "client_session";

/**
 * The denylist holds its preset sections or a deliberate emptying: each
 * section with presets holds every one of them, read by id (a preset a
 * person disabled or edited is still held; so is the data directory's,
 * wherever it points), or is empty because a person emptied it. A section
 * missing some of its presets, or empty with no person having emptied it
 * (never seeded, or emptied by the environment), does not hold, and
 * `permissions.denylist.restorePresets` (Restore) puts them back: each such
 * section is a target of Restore, so a client restores those sections alone
 * and leaves one a person emptied as it is (#573). The line names the lists
 * in setup-copy.md §5.12's words; details say what each is missing. Hosts
 * has no presets, so it always holds.
 */
export const denylistHoldsPresets = (state: DenylistState, presets: Denylist): StateCheckAnswer => {
  const problems: { readonly section: DenylistSection; readonly detail: string }[] = [];
  for (const section of DENYLIST_SECTIONS) {
    const expected = presets[section];
    if (expected.length === 0) continue;
    const entries = state.denylist[section];
    const name = SECTION_NAMES[section];
    if (entries.length === 0) {
      if (!byPerson(state.changedBy[section])) problems.push({ section, detail: `${name}: holds none of its built-in entries, and no person emptied it.` });
      continue;
    }
    const held = new Set(entries.map((entry) => entry.id));
    const missing = expected.filter((entry) => !held.has(entry.id)).map((entry) => entry.pattern);
    if (missing.length === 0) continue;
    const named = missing.slice(0, NAMED).join(", ") + (missing.length > NAMED ? ` and ${missing.length - NAMED} more` : "");
    problems.push({ section, detail: `${name}: ${missing.length} built-in ${missing.length === 1 ? "entry is" : "entries are"} missing: ${named}.` });
  }
  if (problems.length === 0) return true;
  const names = problems.map(({ section }) => SECTION_NAMES[section]);
  return {
    reason: `Some built-in entries are missing from the ${namesWords(names)} always-ask ${names.length === 1 ? "list" : "lists"}.`,
    details: problems.map((problem) => problem.detail),
    targets: problems.map(({ section }): SetupTarget => ({ action: "restore", kind: "denylist-section", id: section, label: SECTION_NAMES[section] })),
  };
};

/** Names in a sentence: "paths", "paths and hosts", "browser domains, paths and hosts". */
const namesWords = (names: readonly string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) as string}`);

/** What agents get at each containment default, as the Permissions step's line says it (setup-copy.md §5.12). */
const CONTAINMENT_WORDS: Readonly<Record<ContainmentLevel, string>> = {
  off: "Agents are not sandboxed",
  workspace: "Agents stay inside the project folder",
  "workspace-no-network": "Agents stay inside the project folder, offline",
};

/**
 * The Permissions step's line when done (#1698; setup-copy.md §5.12): the
 * containment default as it is, which holds at `off` too since nothing has
 * to be enforced, so the line never says agents are sandboxed when nothing
 * is contained; and each denylist section with presets that a person
 * emptied, which holds as well. The containment level's id is in details.
 */
export const permissionsLine = (level: ContainmentLevel, state: DenylistState, presets: Denylist): Finding => {
  const emptied = DENYLIST_SECTIONS.filter((section) => presets[section].length > 0 && state.denylist[section].length === 0).map((section) => SECTION_NAMES[section]);
  const lists = emptied.length === 0 ? "" : ` You emptied the ${namesWords(emptied)} always-ask ${emptied.length === 1 ? "list" : "lists"}.`;
  return { reason: `Set. ${CONTAINMENT_WORDS[level]}.${lists}`, details: [`permissions.containment.default: ${level}`] };
};

/**
 * Not root, from what `permissions.settings.get` answers as `isRoot`: always
 * false while the environment answers, since `serve` refuses root before it
 * starts (ADR 0006), so a check that fails says a refusal was got past.
 */
export const runsAsNonRoot = (isRoot: boolean): StateCheckAnswer =>
  isRoot
    ? {
        reason: `${PRODUCT_NAME} runs as the administrator (root) account, which is unsafe. Restart it as your own user.`,
        details: ["isRoot: true", `${PRODUCT_NAME} serve refuses root; in a container, run it as the image's non-root USER.`],
      }
    : true;
