import { z } from "zod";
import { InstallableToolName, RunnableToolAction, ToolCommandMethod, ToolNotRunnableError } from "../managed-tool-commands.js";
import { DoctorToolName, ManagedToolDetail, ManagedToolName, ManagedToolRow, ManagedToolVerification, ToolCommandLine, ToolDoctorReport, VerifiableToolName } from "../managed-tools.js";
import { commandParams, defineMethod } from "../method.js";
import { Timestamp } from "../primitives.js";
import { TerminalColumns, TerminalId, TerminalRows, ToolTerminalInfo } from "../terminals.js";

/**
 * The Managed tools methods (key-managers spec, "Wire methods"; ADR 0026).
 * `tools.list` reads the registry's rows, which the environment probes: at
 * its start, and on a `refresh` (Set up or About opening) at most every
 * fifteen minutes. A client never probes a tool itself, nor fetches its
 * latest version. `tools.detail` runs a tool's `doctor` (#374);
 * `tools.verify` runs a tool's verify command on the environment (#375);
 * `tools.run` installs or updates a tool in a tool terminal (#376).
 */

/**
 * The managed tools' rows, one per tool in the table's order, as the last
 * probe found them, each with the latest version cached on the environment.
 * With `refresh`, a probe runs first unless one began in the last fifteen
 * minutes; either way the answer waits for a probe under way. A `refresh`
 * also has the environment fetch the latest version of each installed tool
 * whose last fetch was a day or more ago (#374): the answer never waits for
 * it, and a latest that changes a row is heard as `tools.updated`.
 */
export const toolsList = defineMethod({
  name: "tools.list",
  scope: "read",
  kind: "query",
  params: z.object({
    refresh: z.boolean().optional().meta({ description: "Probe first, unless a probe began in the last fifteen minutes: sent when Set up or About opens." }),
  }),
  result: z.object({
    tools: z.array(ManagedToolRow).meta({ description: "One row per managed tool, in the table's order." }),
    probedAt: Timestamp.meta({ description: "When the probe the rows come from began." }),
  }),
  errors: [],
});

/**
 * A tool's detail (#374): its row beside what its `doctor` says, which runs
 * now, on this call (and when Update is clicked, #376), never on a probe,
 * since it is slow. `claude doctor` runs where the row found `claude`,
 * never the bundled binary; its summary's fields are read, with the install
 * method it reports set beside the one the registry detected, since doctor
 * misreports it on ordinary machines. A tool not installed answers
 * `not-installed` and nothing runs.
 */
export const toolsDetail = defineMethod({
  name: "tools.detail",
  scope: "read",
  kind: "query",
  params: z.object({ tool: DoctorToolName }),
  result: ManagedToolDetail,
  errors: [],
});

/**
 * Runs the tool's verify command on the environment (#375), where its row
 * found it, as a holder like any other: with every service's variables, the
 * key managers' block among them, and a run token minted for it and revoked
 * when it exits; the injection setting, which decides what runs are given,
 * never denies it. `bao` and `vault` run `token lookup` against the
 * injecting OpenBao connection, and on a failure `status`, whose exit 2 is
 * sealed and 1 unreachable; `gh` runs `gh auth status`; the Doppler,
 * 1Password and Bitwarden commands run the same way. A tool its row finds
 * not installed answers `not-installed` and nothing runs; a key-manager CLI
 * with no connection of its provider injecting answers `failed` and nothing
 * runs. Only the fields wanted are read from what the command printed, and
 * its output is never kept.
 */
export const toolsVerify = defineMethod({
  name: "tools.verify",
  scope: "admin",
  kind: "query",
  params: z.object({ tool: VerifiableToolName }),
  result: ManagedToolVerification,
  errors: [],
});

/**
 * Installs or updates a tool (#376; ADR 0026): opens a tool terminal with
 * the id given and runs, through the user's login shell, the command the
 * closed command table holds for the tool, the method and this platform
 * (`MANAGED_TOOL_COMMANDS`): Install the first method available here, in
 * the order Homebrew, WinGet, the vendor's apt or dnf repository, the
 * vendor's script; Update the method the tool's row says it was installed
 * by. Run in a terminal pane (`terminal`), and Update of a tool installed
 * by a method the table cannot drive, run the vendor's documented command
 * (`documentedChoice`) in the tool terminal once a person presses Enter
 * there (#1833). `vault` is never installed: its Install runs `bao`'s. Update on
 * `claude` runs its `doctor` first (`tools.detail`), whose report the
 * answer carries beside the method the row detected. The terminal streams
 * through `terminals.subscribe` and takes a `sudo` password through
 * `terminals.write`, which, like its resize and close, needs `admin`; it
 * closes on `terminals.close`, or thirty minutes after its command exits.
 * `tool.run-started` is appended with the command; when the command exits
 * the login shell's PATH is read again, the tool probed (a changed row
 * raising `tools.updated`) and verified, and `tool.run-finished` appended
 * with the exit code and the verification.
 *
 * A tool no method available here installs, one the table has no command
 * for on this platform, or `vault`'s Update is `tool_not_runnable`,
 * answering the vendor's documented command where there is one.
 * One tool run per environment runs at a time, since package managers
 * lock: another while one is under way, even one the row would refuse, is
 * `conflict` reason `tool_run_in_progress`, naming its tool and terminal.
 * An id used on the environment already is `conflict` reason `exists`, and
 * an environment that cannot start a pseudo-terminal `conflict` reason
 * `pty_unavailable`.
 */
export const toolsRun = defineMethod({
  name: "tools.run",
  scope: "admin",
  kind: "command",
  params: commandParams({
    tool: ManagedToolName.meta({ description: "The tool whose row's action this is; vault's Install installs bao." }),
    action: RunnableToolAction,
    id: TerminalId.meta({ description: "The tool terminal's id, a version 4 UUID the client mints so it can subscribe while the command is in flight." }),
    cols: TerminalColumns.optional().meta({ description: "The terminal's width; preset 80." }),
    rows: TerminalRows.optional().meta({ description: "The terminal's height; preset 24." }),
  }),
  result: z.object({
    terminal: ToolTerminalInfo,
    tool: InstallableToolName.meta({ description: "The tool installed or updated: bao for vault's Install." }),
    action: RunnableToolAction,
    method: ToolCommandMethod,
    command: ToolCommandLine.meta({ description: "The command line the login shell runs, each argument quoted as one word." }),
    doctor: ToolDoctorReport.nullable().meta({
      description: "For Update on claude, what claude doctor said before the command ran, to set beside the method the row detected, which the run used; null otherwise.",
    }),
  }),
  errors: [ToolNotRunnableError],
});
