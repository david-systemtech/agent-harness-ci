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
 * when a newer version is known (#374); `below-minimum`, a version under the
 * tool's minimum or one that could not be read; `not-installed`;
 * `method-unknown`, installed but not known how.
 */
export const MANAGED_TOOL_STATUSES = ["current", "update-available", "below-minimum", "not-installed", "method-unknown"] as const;
export const ManagedToolStatus = z.enum(MANAGED_TOOL_STATUSES).meta({
  description:
    "A managed tool's status: current; update-available (a newer version is known, a badge only); below-minimum (its version is under the tool's minimum, or could not be read against one); not-installed; method-unknown (installed, but how could not be told).",
});
export type ManagedToolStatus = z.infer<typeof ManagedToolStatus>;

/** A row's one action (ADR 0026): Install a missing tool, Update one the harness can drive, else Copy the command. */
export const MANAGED_TOOL_ACTIONS = ["install", "update", "copy"] as const;
export const ManagedToolAction = z.enum(MANAGED_TOOL_ACTIONS).meta({
  description:
    "A managed tool's one action: install (it is not installed), update (installed by a method the harness can drive), or copy (the command, for a method it cannot: manual, unknown, mise, asdf, Scoop).",
});
export type ManagedToolAction = z.infer<typeof ManagedToolAction>;

/** One row of the registry: a tool as the last probe found it. */
export const ManagedToolRow = z
  .object({
    tool: ManagedToolName,
    label: z.string().min(1).max(64).meta({ description: "What the row calls the tool: claude's is claude in your terminal." }),
    path: z.string().min(1).nullable().meta({ description: "Where the name resolved on the login shell's PATH (on Windows, the machine and user Path a new logon composes); null when it is not installed." }),
    realpath: z.string().min(1).nullable().meta({ description: "The path with every link resolved, which the install method is read from; null when it is not installed." }),
    version: ManagedToolVersion.nullable().meta({ description: "The version its --version reported within five seconds; null when it is not installed or none was read." }),
    minimum: ManagedToolVersion.nullable().meta({ description: "The tool's declared minimum; null for one that is never required." }),
    method: ManagedToolInstallMethod.nullable().meta({ description: "How it was installed; null when it is not installed." }),
    status: ManagedToolStatus,
    action: ManagedToolAction,
  })
  .meta({ description: "A managed tool as the environment's last probe found it: where, which version against its minimum, how it was installed, its status and its one action." });
export type ManagedToolRow = z.infer<typeof ManagedToolRow>;

/** `tools.updated`'s payload: the rows a probe changed, as they are now. */
export const ToolsUpdatedPayload = z
  .object({ tools: z.array(ManagedToolRow).min(1).meta({ description: "The rows that changed, as they are now, in the table's order." }) })
  .meta({ description: "A probe changed managed-tool rows: those rows as they are now." });
export type ToolsUpdatedPayload = z.infer<typeof ToolsUpdatedPayload>;
