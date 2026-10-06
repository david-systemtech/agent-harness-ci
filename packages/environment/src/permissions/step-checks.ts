import {
  DENYLIST_SECTIONS,
  type ContainmentCause,
  type ContainmentLevel,
  type ContainmentReport,
  type Denylist,
  type DenylistSection,
  type ReasonTime,
  type SetupTarget,
} from "@agent-harness/contracts";
import { parseActor } from "../event-log/event-log.js";
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
  | { readonly holds: true; readonly reason: string; readonly pending?: never; readonly targets?: never; readonly times?: never }
  | { readonly holds?: false; readonly reason: string; readonly pending?: true; readonly targets?: readonly SetupTarget[]; readonly times?: readonly ReasonTime[] };

/**
 * What a person can do on Linux about a containment level the probe refused:
 * Claude Code's own setup for its sandbox (the bubblewrap and socat packages,
 * and on Ubuntu 24.04 the AppArmor profile that lets `bwrap` create user
 * namespaces), then a restart, since the probe runs once, as the environment
 * starts (#133).
 */
export const CONTAINMENT_LINUX_HINT =
  "On Linux, install the bubblewrap and socat packages (sudo apt-get install bubblewrap socat); on Ubuntu 24.04 and later, where AppArmor restricts unprivileged user namespaces, also add an AppArmor profile that grants bwrap userns (/etc/apparmor.d/bwrap, as Claude Code's sandboxing documentation gives it) and reload AppArmor. Then restart the environment, which probes containment as it starts.";

/** What a container also needs when its seccomp profile refused the namespace (#133's finding on the agent box). */
const CONTAINER_SECCOMP_HINT = "In a container, start it with a seccomp profile that allows unshare(CLONE_NEWUSER).";

/**
 * The causes the machine itself can remove, for which the package hint is
 * given: what the probe found on it (a missing binary, the kernel, AppArmor,
 * seccomp, socat, a failing mechanism). Not the adapter's (no package makes
 * an adapter enforce containment), the platform's (native Windows has no
 * mechanism), or a probe that failed or never ran.
 */
const MACHINE_CAUSES: ReadonlySet<ContainmentCause> = new Set<ContainmentCause>(["binary_missing", "userns_blocked", "apparmor", "seccomp", "socat_missing", "failed"]);

/**
 * The containment default holds when this environment can enforce it; `off`
 * always can. A default that was set on a start whose probe allowed it and
 * that a later start's probe refuses (bubblewrap removed, the kernel
 * changed) does not, and the line names the level, the probe's reason and,
 * where installing or configuring something would help, the Linux package
 * hint.
 */
export const containmentDefaultHolds = (level: ContainmentLevel, report: ContainmentReport): StateCheckAnswer => {
  const why = unenforceable(report, level);
  if (why === null) return true;
  const hints = MACHINE_CAUSES.has(why.cause) ? [CONTAINMENT_LINUX_HINT, ...(why.cause === "seccomp" ? [CONTAINER_SECCOMP_HINT] : [])] : [];
  return { reason: [`The containment default ${level} cannot be enforced here: ${why.reason}`, ...hints].join(" ") };
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
 * and leaves one a person emptied as it is (#573). Hosts has no presets, so
 * it always holds.
 */
export const denylistHoldsPresets = (state: DenylistState, presets: Denylist): StateCheckAnswer => {
  const problems: { readonly section: DenylistSection; readonly line: string }[] = [];
  for (const section of DENYLIST_SECTIONS) {
    const expected = presets[section];
    if (expected.length === 0) continue;
    const entries = state.denylist[section];
    const name = `The ${SECTION_NAMES[section]} section of the denylist`;
    if (entries.length === 0) {
      if (!byPerson(state.changedBy[section])) problems.push({ section, line: `${name} holds none of its presets, and no person emptied it; Restore puts them back.` });
      continue;
    }
    const held = new Set(entries.map((entry) => entry.id));
    const missing = expected.filter((entry) => !held.has(entry.id)).map((entry) => entry.pattern);
    if (missing.length === 0) continue;
    const named = missing.slice(0, NAMED).join(", ") + (missing.length > NAMED ? ` and ${missing.length - NAMED} more` : "");
    problems.push({ section, line: `${name} is missing ${missing.length} of its presets (${named}); Restore puts them back.` });
  }
  if (problems.length === 0) return true;
  return {
    reason: problems.map((problem) => problem.line).join(" "),
    targets: problems.map(({ section }): SetupTarget => ({ action: "restore", kind: "denylist-section", id: section, label: SECTION_NAMES[section] })),
  };
};

/** What sessions get at each containment default, as the Permissions step's line says it. */
const CONTAINMENT_WORDS: Readonly<Record<ContainmentLevel, string>> = {
  off: "Containment is off",
  workspace: "Sessions are contained to their workspace",
  "workspace-no-network": "Sessions are contained to their workspace with no network",
};

/**
 * The Permissions step's line when done (#1698): the containment default as
 * it is, which holds at `off` too since nothing has to be enforced, so the
 * line never says containment is enforced when nothing is contained; and
 * each denylist section with presets that a person emptied, which holds as
 * well.
 */
export const permissionsLine = (level: ContainmentLevel, state: DenylistState, presets: Denylist): string => {
  const emptied = DENYLIST_SECTIONS.filter((section) => presets[section].length > 0 && state.denylist[section].length === 0).map((section) => SECTION_NAMES[section]);
  const names = emptied.length <= 1 ? emptied.join("") : `${emptied.slice(0, -1).join(", ")} and ${emptied.at(-1) as string}`;
  const denylist = emptied.length === 0 ? "the denylist holds its presets" : `the denylist's ${names} ${emptied.length === 1 ? "section is" : "sections are"} emptied`;
  return `${CONTAINMENT_WORDS[level]}, and ${denylist}.`;
};

/**
 * Not root, from what `permissions.settings.get` answers as `isRoot`: always
 * false while the environment answers, since `serve` refuses root before it
 * starts (ADR 0006), so a check that fails says a refusal was got past.
 */
export const runsAsNonRoot = (isRoot: boolean): StateCheckAnswer =>
  isRoot ? { reason: "The environment runs as root, which it must never do: start it as an ordinary user (the container's non-root USER)." } : true;
