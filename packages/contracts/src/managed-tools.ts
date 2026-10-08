import { z } from "zod";
import { GH_MINIMUM_VERSION } from "./forge-gh.js";
import { KeyManagerProvider } from "./key-managers.js";

/**
 * The Managed tools table (key-managers spec, "Managed tools"; ADR 0011,
 * ADR 0026): the CLIs the harness depends on, as data, each with the
 * minimum the harness declares and the command that proves it works, and
 * the rows the environment's registry answers for them. The environment
 * probes; clients never do, and read the rows.
 */

/** The managed tools of milestone 1; Codex and the local-model tools arrive with their milestone-2 adapters. */
export const MANAGED_TOOL_NAMES = ["claude", "bao", "vault", "doppler", "op", "bws", "gh"] as const;
export const ManagedToolName = z.enum(MANAGED_TOOL_NAMES).meta({
  description:
    "A managed tool, by the name it is found under on the PATH: claude (claude in your terminal, never the bundled binary), bao (OpenBao), vault (Vault), doppler, op (1Password), bws (Bitwarden Secrets Manager) or gh (GitHub).",
});
export type ManagedToolName = z.infer<typeof ManagedToolName>;

/** A version as a tool reports it, read from its `--version`: major, minor and an optional patch, with any prerelease or build part. */
export const ManagedToolVersion = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.+-]+)?$/)
  .meta({ description: "A tool's version, as 2.63.2: major, minor and an optional patch, with any prerelease (-beta.1) or build (+ent) part; no leading v." });
export type ManagedToolVersion = z.infer<typeof ManagedToolVersion>;

/** One argument of a fixed command: not empty, no white space or control character, so it is one word and never a shell line. */
const Argument = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^\s\p{Cc}]+$/u);

// When a tool is required: a required tool missing or below its minimum is a health failure on the step that needs it (ADR 0026).
const NeverRequired = z.object({ kind: z.literal("never") }).meta({ description: "Never required: shown for the person's own use." });
const KeyManagerRequirement = z
  .object({ kind: z.literal("key-manager"), provider: KeyManagerProvider })
  .meta({ description: "Required while a connection of the provider injects; any tool for the provider satisfies it (bao or vault for OpenBao)." });
const ForgeGhRequirement = z.object({ kind: z.literal("forge-gh") }).meta({ description: "Required while a forge account reads its token from the environment's gh." });

const label = z.string().min(1).max(64).meta({ description: "What a row calls the tool." });
const verify = z.array(Argument).min(1).max(8).meta({ description: "The command that proves the tool works, as the fixed arguments after its name." });

/**
 * One entry of the table: a tool, its label, its minimum, its verify
 * command and when it is required. A tool that can be required declares a
 * minimum and a verify command; one that never is may leave them out.
 */
export const ManagedTool = z
  .union([
    z
      .object({
        name: ManagedToolName,
        label,
        minimum: ManagedToolVersion.meta({ description: "The oldest version the harness works with." }),
        verify,
        requiredFor: z.discriminatedUnion("kind", [KeyManagerRequirement, ForgeGhRequirement]),
      })
      .meta({ description: "A tool that can be required, with its minimum and its verify command." }),
    z
      .object({
        name: ManagedToolName,
        label,
        minimum: ManagedToolVersion.nullable().meta({ description: "The oldest version the harness works with; null for none." }),
        verify: verify.nullable(),
        requiredFor: NeverRequired,
      })
      .meta({ description: "A tool that is never required, shown for the person's own use." }),
  ])
  .meta({ description: "A managed tool as the table declares it: its name, label, minimum, verify command and when it is required." });
export type ManagedTool = z.infer<typeof ManagedTool>;

/**
 * The table. The minimums are the key-managers spec's (chosen defaults):
 * `bao` 2.1.1, the release the environment contract was measured on;
 * `vault` 1.14.0, the fork point; `doppler` 3.76.0; `op` 2.18.0, the first
 * with service accounts; `bws` 0.3.0, the first with noun-first commands;
 * `gh` 2.40, the first whose `gh auth token` takes a user (forge spec).
 * OpenBao and Vault verify with `token lookup`, a failure followed by
 * `status` (exit 2 sealed, 1 unreachable), whose runner is the verify
 * commands' (#375).
 */
export const MANAGED_TOOLS = [
  { name: "claude", label: "claude in your terminal", minimum: null, verify: null, requiredFor: { kind: "never" } },
  { name: "bao", label: "OpenBao CLI", minimum: "2.1.1", verify: ["token", "lookup"], requiredFor: { kind: "key-manager", provider: "openbao" } },
  { name: "vault", label: "Vault CLI", minimum: "1.14.0", verify: ["token", "lookup"], requiredFor: { kind: "key-manager", provider: "openbao" } },
  { name: "doppler", label: "Doppler CLI", minimum: "3.76.0", verify: ["secrets", "--only-names", "--json"], requiredFor: { kind: "key-manager", provider: "doppler" } },
  { name: "op", label: "1Password CLI", minimum: "2.18.0", verify: ["whoami"], requiredFor: { kind: "key-manager", provider: "onepassword" } },
  { name: "bws", label: "Bitwarden Secrets Manager CLI", minimum: "0.3.0", verify: ["project", "list"], requiredFor: { kind: "key-manager", provider: "bitwarden" } },
  { name: "gh", label: "GitHub CLI", minimum: GH_MINIMUM_VERSION, verify: ["auth", "status"], requiredFor: { kind: "forge-gh" } },
] as const satisfies readonly ManagedTool[];

/** The table's entry for `name`. */
export const managedTool = (name: ManagedToolName): ManagedTool => {
  const tool = MANAGED_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) throw new Error(`The Managed tools table has no ${name}.`);
  return tool;
};

/** What a version's parts compare by: the numbers, and whether it is a prerelease. */
const partsOf = (version: string): { readonly numbers: readonly [number, number, number]; readonly prerelease: boolean } => {
  const [core = "", ...rest] = version.split("+")[0]?.split("-") ?? [];
  const [major = 0, minor = 0, patch = 0] = core.split(".").map(Number);
  return { numbers: [major, minor, patch], prerelease: rest.length > 0 };
};

/**
 * Orders two versions: negative when `a` is older, positive when newer, 0
 * when the same. By their numbers, a missing patch reading as 0; a
 * prerelease comes before its release; a build part counts for nothing.
 */
export const compareToolVersions = (a: ManagedToolVersion, b: ManagedToolVersion): number => {
  const left = partsOf(a);
  const right = partsOf(b);
  for (let at = 0; at < 3; at += 1) {
    const difference = (left.numbers[at] ?? 0) - (right.numbers[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return Number(right.prerelease) - Number(left.prerelease);
};

/**
 * How a tool was installed, read from where it is (ADR 0026): the shape of
 * its path (a Homebrew Cellar or Caskroom, WinGet's packages or links,
 * Scoop, mise, asdf, `node_modules`), for `claude` its native installer's
 * versions directory, else the system package that owns it (`dpkg -S`,
 * `rpm -qf`); `manual` when nothing claims it, `unknown` when the owner
 * could not be asked.
 */
export const MANAGED_TOOL_INSTALL_METHODS = ["homebrew", "winget", "scoop", "mise", "asdf", "npm", "native", "apt", "dnf", "manual", "unknown"] as const;
export const ManagedToolInstallMethod = z.enum(MANAGED_TOOL_INSTALL_METHODS).meta({
  description:
    "How a tool was installed: homebrew (a Cellar or Caskroom), winget (WinGet's packages or links), scoop, mise, asdf, npm (a node_modules path), native (claude's native installer, its versions directory), apt (a package dpkg owns), dnf (a package rpm owns), manual (nothing claims it) or unknown (the package owner could not be asked).",
});
export type ManagedToolInstallMethod = z.infer<typeof ManagedToolInstallMethod>;

/**
 * A row's status (ADR 0026): `current`; `update-available`, a badge only,
 * when its version is behind the latest known (#374), which raises no
 * notice and fails no check; `below-minimum`, a version under the tool's
 * minimum or one that could not be read; `not-installed`; `method-unknown`,
 * installed but not known how. One holds, in the order `not-installed`,
 * `below-minimum`, `method-unknown`, `update-available`, `current`.
 */
export const MANAGED_TOOL_STATUSES = ["current", "update-available", "below-minimum", "not-installed", "method-unknown"] as const;
export const ManagedToolStatus = z.enum(MANAGED_TOOL_STATUSES).meta({
  description:
    "A managed tool's status: current; update-available (its version is behind the latest known, a badge only: it raises no notice and fails no check); below-minimum (its version is under the tool's minimum, or could not be read against one); not-installed; method-unknown (installed, but how could not be told). Below the minimum is said before method-unknown, and both before update-available.",
});
export type ManagedToolStatus = z.infer<typeof ManagedToolStatus>;

/**
 * A row's one action (ADR 0026, #1833): Install a missing tool, Update one
 * the harness can drive, else Run in a terminal pane, the vendor's command
 * typed out in a tool terminal for a person to start with Enter; Copy only
 * where the harness has no command to run: `vault`.
 */
export const MANAGED_TOOL_ACTIONS = ["install", "update", "terminal", "copy"] as const;
export const ManagedToolAction = z.enum(MANAGED_TOOL_ACTIONS).meta({
  description:
    "A managed tool's one action: install (it is not installed); update (installed by a method the harness can drive); terminal (Run in a terminal pane: installed by a method it cannot drive, such as one that could not be told, so the row's command runs in a tool terminal once a person presses Enter there, and can be copied besides); or copy (nothing the harness runs: vault, which it never installs or updates, and rows recorded before terminal existed).",
});
export type ManagedToolAction = z.infer<typeof ManagedToolAction>;

/** A command line as the login shell runs it, or as a person copies it. */
export const ToolCommandLine = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^\r\n]+$/)
  .meta({ description: "A command line, each argument quoted as one word, steps joined by &&: as the user's login shell runs it, or as a person copies it." });

/** One row of the registry: a tool as the last probe found it. */
export const ManagedToolRow = z
  .object({
    tool: ManagedToolName,
    label: z.string().min(1).max(64).meta({ description: "What the row calls the tool: claude's is claude in your terminal." }),
    path: z.string().min(1).nullable().meta({ description: "Where the name resolved on the login shell's PATH (on Windows, the machine and user Path a new logon composes); null when it is not installed." }),
    realpath: z.string().min(1).nullable().meta({ description: "The path with every link resolved, which the install method is read from; null when it is not installed." }),
    version: ManagedToolVersion.nullable().meta({ description: "The version its --version reported within five seconds; null when it is not installed or none was read." }),
    latest: ManagedToolVersion.nullable().meta({
      description:
        "The newest release known, from the source matching its install method (the Homebrew API for homebrew, WinGet's manifests for winget, the npm registry's configured update-channel dist-tag for claude on npm), else the vendor's release feed (GitHub releases for bao, doppler, bws and gh; Claude Code's configured update channel for claude; 1Password's update feed for op; HashiCorp's releases API for vault): fetched by the environment at most once a day, when a client asks tools.list to refresh, and cached on the environment. Null while none is known, and when it is not installed. A version behind it is update-available.",
    }),
    minimum: ManagedToolVersion.nullable().meta({ description: "The tool's declared minimum; null for one that is never required." }),
    method: ManagedToolInstallMethod.nullable().meta({ description: "How it was installed; null when it is not installed." }),
    status: ManagedToolStatus,
    action: ManagedToolAction,
    command: ToolCommandLine.nullable().meta({
      description:
        "For a terminal or Copy row, the vendor's documented command (#426, #1833): a bare binary's update, else the vendor script's, where the tool has one, else the install the command table would run here, else the first it has for this platform; a terminal row's tools.run runs it once a person presses Enter, and a person can copy it. Null for an Install or Update row, whose command tools.run runs and answers, and for a row the table has nothing for (vault, which the harness never installs or updates).",
    }),
  })
  .meta({
    description:
      "A managed tool as the environment's last probe found it: where, which version against its minimum and the latest known, how it was installed, its status, its one action and, for a terminal or Copy row, the vendor's command.",
  });
export type ManagedToolRow = z.infer<typeof ManagedToolRow>;

/** The tools that serve a key-manager provider, in the table's order: bao and vault for OpenBao, doppler, op and bws for the others. */
export const keyManagerClis = (provider: KeyManagerProvider): ManagedToolName[] =>
  MANAGED_TOOLS.filter(({ requiredFor }) => requiredFor.kind === "key-manager" && requiredFor.provider === provider).map(({ name }) => name);

/**
 * A key-manager connection's CLI row among `rows` (key-managers spec, "Wire
 * methods"; #375): the first installed of the tools that serve its
 * provider, so `bao`, else `vault` for OpenBao; else the first's, not
 * installed, whose action installs it (never `vault`'s).
 */
export const keyManagerCliRow = (provider: KeyManagerProvider, rows: readonly ManagedToolRow[]): ManagedToolRow => {
  const serving = keyManagerClis(provider).map((name) => rows.find((row) => row.tool === name));
  const row = serving.find((candidate) => candidate !== undefined && candidate.status !== "not-installed") ?? serving[0];
  if (row === undefined) throw new Error(`No managed-tool row serves ${provider}.`);
  return row;
};

/** The tools a verify command proves: every one with a verify command, which `claude` has not. */
export const VerifiableToolName = ManagedToolName.exclude(["claude"]).meta({
  description: "A managed tool with a verify command: bao, vault, doppler, op, bws or gh; claude has none.",
});
export type VerifiableToolName = z.infer<typeof VerifiableToolName>;

/** How a verify command came out: it `passed`, it `failed`, or the tool is `not-installed`, so nothing ran. */
export const MANAGED_TOOL_VERIFY_OUTCOMES = ["passed", "failed", "not-installed"] as const;
export const ManagedToolVerifyOutcome = z.enum(MANAGED_TOOL_VERIFY_OUTCOMES).meta({
  description: "How a verify command came out: passed; failed; or not-installed, the tool not found where its row says, so nothing ran.",
});
export type ManagedToolVerifyOutcome = z.infer<typeof ManagedToolVerifyOutcome>;

/**
 * What `tools.verify` answers (key-managers spec, "Managed tools"; #375):
 * the tool, how its verify command came out, and one line saying why, read
 * from only the fields the harness wants of what it printed, never the
 * output itself; what it keeps of standard error has passed the scrub
 * registry.
 */
export const ManagedToolVerification = z
  .object({
    tool: VerifiableToolName,
    outcome: ManagedToolVerifyOutcome,
    reason: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[^\r\n]+$/)
      .meta({
        description:
          "One line saying why: what passed (for bao or vault, the run token's policies; for gh, the hosts and logins it is signed in to), or what failed (OpenBao sealed, unreachable, a lookup refused, no connection injecting for the tool's provider), scrubbed of every secret.",
      }),
  })
  .meta({ description: "A managed tool's verify command, as it came out: the tool, passed, failed or not installed, and one line saying why." });
export type ManagedToolVerification = z.infer<typeof ManagedToolVerification>;

/** The tools with a `doctor` command, which `tools.detail` runs (#374): claude's; Codex's arrives with its milestone-2 adapter. */
export const DoctorToolName = ManagedToolName.extract(["claude"]).meta({
  description: "A managed tool with a doctor command, which tools.detail runs: claude.",
});
export type DoctorToolName = z.infer<typeof DoctorToolName>;

/** One line of text as `doctor` printed it, scrubbed. */
const doctorText = z
  .string()
  .max(1024)
  .regex(/^[^\r\n]*$/);

/** One field of `doctor`'s summary, as it printed it: `Running: native (2.1.283)` is the name `Running` and the value `native (2.1.283)`. */
export const ToolDoctorField = z
  .object({
    name: doctorText.min(1).max(64).meta({ description: "The field's name, as doctor printed it: Running, Path, Config install method, Auto-updates, ..." }),
    value: doctorText.meta({ description: "Its value, as doctor printed it." }),
  })
  .meta({ description: "One field of doctor's summary: its name and its value, as printed." });
export type ToolDoctorField = z.infer<typeof ToolDoctorField>;

/** One warning `doctor` found, with the fix it suggests when it gives one. */
export const ToolDoctorWarning = z
  .object({
    issue: doctorText.min(1).meta({ description: "What doctor found, as it printed it." }),
    fix: doctorText.min(1).nullable().meta({ description: "The fix it suggests; null when it gives none." }),
  })
  .meta({ description: "A warning doctor found, and the fix it suggests." });
export type ToolDoctorWarning = z.infer<typeof ToolDoctorWarning>;

/**
 * What the tool's `doctor` said (#374): its fields, the install method it
 * reports in the registry's words, and its warnings; that it failed, and
 * why; or that the tool is not installed, so nothing ran.
 */
export const ToolDoctorReport = z
  .discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.literal("read"),
        method: ManagedToolInstallMethod.nullable().meta({
          description:
            "The install method doctor reports, in the registry's words (native; npm-global and npm-local as npm; a package manager's homebrew, winget, mise, asdf, deb as apt and rpm as dnf; unknown), to set beside the row's detected one: doctor misreports it on ordinary machines. Null when its words map to none of them (a development build, pacman, apk).",
        }),
        fields: z.array(ToolDoctorField).max(64).meta({ description: "Its summary's fields, in the order it printed them." }),
        warnings: z.array(ToolDoctorWarning).max(32).meta({ description: "The warnings it found, in its order; empty when it found no installation issue." }),
      })
      .meta({ description: "doctor ran and its summary was read." }),
    z
      .object({
        outcome: z.literal("failed"),
        reason: doctorText.min(1).meta({ description: "Why nothing was read: it gave no answer in time, exited with an error, or printed no summary; scrubbed." }),
      })
      .meta({ description: "doctor ran, and nothing could be read from it." }),
    z.object({ outcome: z.literal("not-installed") }).meta({ description: "The tool is not installed, so nothing ran." }),
  ])
  .meta({ description: "What a tool's doctor said: its fields, the install method it reports and its warnings; that it failed; or that the tool is not installed." });
export type ToolDoctorReport = z.infer<typeof ToolDoctorReport>;

/**
 * What `tools.detail` answers (key-managers spec, "Wire methods"; ADR 0026;
 * #374): the tool's row, whose method is the one the registry detected
 * from where the tool is, beside what its `doctor` said, so a difference
 * between the two methods shows.
 */
export const ManagedToolDetail = z
  .object({
    tool: DoctorToolName,
    row: ManagedToolRow.meta({ description: "The tool's row, as the registry holds it: its method is the one detected from where the tool is." }),
    doctor: ToolDoctorReport,
  })
  .meta({ description: "A managed tool's detail: its row, with the install method detected, and what its doctor said, with the install method it reports." });
export type ManagedToolDetail = z.infer<typeof ManagedToolDetail>;

/** `tools.updated`'s payload: the rows a probe, or a latest version fetched (#374), changed, as they are now. */
export const ToolsUpdatedPayload = z
  .object({ tools: z.array(ManagedToolRow).min(1).meta({ description: "The rows that changed, as they are now, in the table's order." }) })
  .meta({ description: "A probe, or a latest version fetched, changed managed-tool rows: those rows as they are now." });
export type ToolsUpdatedPayload = z.infer<typeof ToolsUpdatedPayload>;
