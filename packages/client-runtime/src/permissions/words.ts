import { Denylist, PRODUCT_NAME, denylistPresets, type AutoDecider, type ContainmentAvailability, type ContainmentLevel, type DenylistSection, type DenylistTestKind, type Mode, type ParkedPromptTtl, type ReviewCounts, type ReviewDenial, type ReviewRun } from "@agent-harness/contracts";
import { whenWords } from "../transcript/format.js";

/**
 * What the Permissions row says (permissions spec, "Containment", "The
 * denylist"; docs/specs/gui.md, "Settings"; #415), as both renderers say
 * it: a containment level's availability, a denylist section's name, what
 * it holds and the grammar its patterns follow (the contracts' own
 * descriptions), what a test takes, and the Unattended review's runs,
 * which the terminal UI's `/review` says too; and why a prompt was settled
 * with nobody answering it, as its `prompt-resolved` notice and the GUI's
 * transcript row both say it (#1780).
 */

/** Why a prompt was settled with nobody answering it: the automatic rule that decided it. */
export const DECIDED_BECAUSE: Readonly<Record<AutoDecider, string>> = {
  ttl: "nobody answered it before its time ran out",
  unattended: "nobody was present to answer it",
  bypass: "the run bypasses permissions",
  run_ended: "its run ended first",
  reviewer: "the provider's reviewer decided it",
  cancelled: "the provider withdrew it",
};

/** How much agents may do without asking, each mode as a choice says it (setup-copy.md §5.12): its label, and the sentence under it. The mode's id is for Details. */
export const MODE_WORDS: { readonly [M in Mode]: { readonly label: string; readonly note: string } } = {
  plan: { label: "Ask before any change", note: "Agents can read and plan. They ask before changing anything." },
  acceptEdits: { label: "Edit files, ask for the rest", note: "Agents can edit files in your project. They ask before running commands." },
  auto: { label: "Let Claude decide", note: "Claude reviews each action and asks you only when it is unsure." },
  bypassPermissions: { label: "Never ask", note: "Agents act without asking. Use it only for trusted work in a sandbox." },
};

/** Each sandbox level as a choice names it (setup-copy.md §5.12). */
export const SANDBOX_LEVEL_WORDS: { readonly [Level in ContainmentLevel]: string } = {
  off: "Off",
  workspace: "Project folder",
  "workspace-no-network": "Project folder, no internet",
};

/** Whether a sandbox level works on the computer, as its choice says it: a level the probe did not report needs setup too. */
export const sandboxReadiness = (availability: ContainmentAvailability | undefined): "Works here" | "Needs setup" => (availability?.available === true ? "Works here" : "Needs setup");

/** A command a person copies to run, under the label that says what it does. */
export interface CommandToCopy {
  readonly label: string;
  readonly text: string;
}

/** How to set up a sandbox level the computer cannot give yet: what to do, the commands to run, and the restart after them, since the probe runs as agent-harness starts. */
export interface SandboxSetup {
  readonly line: string;
  readonly commands: readonly CommandToCopy[];
  /** The restart that checks the sandbox again; absent where nothing on the computer helps. */
  readonly restart?: CommandToCopy;
}

const PACKAGES: readonly CommandToCopy[] = [
  { label: "On Ubuntu or Debian", text: "sudo apt-get install bubblewrap socat" },
  { label: "On Fedora", text: "sudo dnf install bubblewrap socat" },
  { label: "On Arch Linux", text: "sudo pacman -S bubblewrap socat" },
];

/** The AppArmor profile Claude Code's sandboxing documentation gives for bwrap on Ubuntu 24.04 and later, written and loaded. */
const APPARMOR_RULE: CommandToCopy = {
  label: "Add the rule",
  text: "printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n}\\n' | sudo tee /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap",
};

/** The kernel's two switches for unprivileged user namespaces, kept on across reboots. */
const USER_NAMESPACES: CommandToCopy = {
  label: "Turn them on",
  text: "printf 'kernel.unprivileged_userns_clone = 1\\nuser.max_user_namespaces = 15000\\n' | sudo tee /etc/sysctl.d/90-user-namespaces.conf && sudo sysctl --system",
};

/**
 * How to set up a sandbox level the probe refused, by its cause (setup-copy.md
 * §5.12's How to set it up and How to fix it): the OS's commands, copyable,
 * for what the computer itself can fix, then the restart, which a container
 * gets from docker compose; a line alone where nothing on the computer helps.
 */
export const sandboxSetup = (availability: Extract<ContainmentAvailability, { readonly available: false }>, container: boolean): SandboxSetup => {
  const restart: CommandToCopy = {
    label: `Then restart ${PRODUCT_NAME}, which checks the sandbox as it starts`,
    text: container ? "docker compose restart environment" : `${PRODUCT_NAME} service stop && ${PRODUCT_NAME} service start`,
  };
  switch (availability.cause) {
    case "binary_missing":
    case "socat_missing":
      return { line: "Install bubblewrap and socat, the two programs the sandbox uses on Linux.", commands: PACKAGES, restart };
    case "apparmor":
      return { line: "Ubuntu needs a rule that lets the sandbox start. Add it with this command.", commands: [APPARMOR_RULE], restart };
    case "userns_blocked":
      return { line: "Linux has turned off the user namespaces the sandbox needs.", commands: [USER_NAMESPACES], restart };
    case "seccomp":
      return container
        ? { line: "The container's security profile stops the sandbox. Start the container with a seccomp profile that allows user namespaces.", commands: [], restart }
        : { line: `A security filter on ${PRODUCT_NAME} stops the sandbox. Start ${PRODUCT_NAME} without it.`, commands: [], restart };
    case "failed":
      return { line: "The sandbox did not start here. On Linux, install bubblewrap and socat; on Ubuntu, also add the rule.", commands: [...PACKAGES, APPARMOR_RULE], restart };
    case "platform":
      return { line: `This computer has no sandbox ${PRODUCT_NAME} can use. On Windows, run ${PRODUCT_NAME} in WSL2 to use one.`, commands: [] };
    case "adapter":
      return { line: "The agent this computer runs cannot use a sandbox.", commands: [] };
    case "probe_failed":
    case "not_probed":
      return { line: `${PRODUCT_NAME} has not checked the sandbox here yet.`, commands: [], restart };
  }
};

/** A choice of how long a question nobody answers waits before it is denied. */
export interface PromptTimeoutChoice {
  readonly label: string;
  readonly value: ParkedPromptTtl;
}

/** If nobody answers a question, Deny it after (setup-copy.md §5.12). */
export const PROMPT_TIMEOUT_CHOICES: readonly PromptTimeoutChoice[] = [
  { label: "1 hour", value: { amount: 1, unit: "hours" } },
  { label: "24 hours", value: { amount: 24, unit: "hours" } },
  { label: "2 days", value: { amount: 2, unit: "days" } },
  { label: "Never deny it", value: "never" },
];

/** Whether two timeouts are the same: never, or one duration in the same unit. */
export const isTimeout = (a: ParkedPromptTtl, b: ParkedPromptTtl): boolean => (a === "never" || b === "never" ? a === b : a.amount === b.amount && a.unit === b.unit);

/** A duration in words: "30 minutes", "1 day". */
const durationWords = ({ amount, unit }: Exclude<ParkedPromptTtl, "never">): string => `${amount} ${amount === 1 ? unit.slice(0, -1) : unit}`;

/** The choices for a timeout now at `current`: the four, and first the one set elsewhere (the CLI, another version) when it is none of them, so it shows as chosen. */
export const promptTimeoutChoices = (current: ParkedPromptTtl): readonly PromptTimeoutChoice[] =>
  current === "never" || PROMPT_TIMEOUT_CHOICES.some((choice) => isTimeout(choice.value, current)) ? PROMPT_TIMEOUT_CHOICES : [{ label: durationWords(current), value: current }, ...PROMPT_TIMEOUT_CHOICES];

/** Each denylist section's name, in the order the denylist holds them. */
export const DENYLIST_SECTION_NAMES: Readonly<Record<DenylistSection, string>> = {
  browserDomains: "Browser domains",
  paths: "Paths",
  commandPatterns: "Command patterns",
  hosts: "Hosts",
};

/** What a section holds, in the contracts' words. */
export const sectionHolds = (section: DenylistSection): string => Denylist.shape[section].description ?? "";

/** The grammar a section's patterns follow, in the contracts' words. */
export const sectionGrammar = (section: DenylistSection): string => Denylist.shape[section].element.shape.pattern.description ?? "";

/** The presets by section: which sections have any does not depend on the data directory, whose path only one of them holds. */
const PRESETS = denylistPresets("/");

/** Whether a section has presets to restore: every section but the hosts, which start empty. */
export const sectionHasPresets = (section: DenylistSection): boolean => PRESETS[section].length > 0;

/** What a tested value is taken as, by `permissions.denylist.test`'s kind. */
export const DENYLIST_TEST_KIND_NAMES: Readonly<Record<DenylistTestKind, string>> = {
  path: "A path",
  command: "A command line",
  host: "A host or URL",
  browserDomain: "A browser address",
};

/** What the Unattended review says with no run to list. */
export const NOTHING_TO_REVIEW = "Nothing to review: no run since the review was last seen.";

/** When a reviewed run started, where the client is: its clock time today, else its day too. */
export const reviewRanWords = (run: Pick<ReviewRun, "ranAt">, now: Date): string => whenWords(run.ranAt, now);

/** Who ran a reviewed run, whether anyone was there, its mode with its clamp, and its containment: `routine nightly · unattended · acceptEdits · workspace`. */
export const reviewRunWords = (run: ReviewRun): string => {
  const who = run.actor.name !== null ? `${run.actor.kind} ${run.actor.name}` : run.actor.kind;
  const mode = run.mode.clamped ? `${run.mode.effective} (clamped from ${run.mode.requested ?? "the default"})` : run.mode.effective;
  return `${who} · ${run.attended ? "attended" : "unattended"} · ${mode} · ${run.containment.effective}`;
};

/** A reviewed run's calls counted: `3 calls: 2 auto-approved, 1 denied, 0 by a person, 0 expired`. */
export const reviewCountsWords = (counts: ReviewCounts): string =>
  `${counts.toolCalls} call${counts.toolCalls === 1 ? "" : "s"}: ${counts.autoApproved} auto-approved, ${counts.denied} denied, ${counts.answeredByPerson} by a person, ${counts.expired} expired`;

/** A denied call: `denied Bash: rm -rf /tmp/cache (denylist: the command matches the denylist)`; a prompt that named no call, "a prompt". */
export const reviewDenialWords = (denial: ReviewDenial): string => `denied ${denial.tool ?? "a prompt"}: ${denial.summary} (${denial.decidedBy}: ${denial.reason})`;
