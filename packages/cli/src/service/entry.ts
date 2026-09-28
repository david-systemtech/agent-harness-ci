import { PRODUCT_NAME } from "@agent-harness/contracts";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { VERSION_CLI_ENTRY, VERSION_SENTINEL, versionNode, VERSIONS_DIRECTORY } from "../launch/versions.js";
import { batchArgument, batchSetValue, oneLine, shellWord } from "./quoting.js";
import { LOG_DIRECTORY, LOG_FILE } from "./spec.js";

/**
 * The launcher entry (launcher-update spec, "Versions and the launcher"): the
 * stable script in the data directory that the service definition runs. It
 * starts the launcher of the version the launcher version file names, that
 * version's own Node on its CLI, as `launch` with the data directory, the
 * port and the name, so a handover changes one line of a file and never the
 * definition. `service install` rewrites it whenever it runs; the entry
 * writes nothing yet (#341 adds its start counter and fallback).
 */

/** The two kinds of script `service install` lays out: `sh` on macOS and Linux, a `cmd` batch file on Windows. */
export type ScriptKind = "sh" | "cmd";

export const scriptKind = (platform: NodeJS.Platform): ScriptKind => (platform === "win32" ? "cmd" : "sh");

/** The launcher entry's file in the data directory, by kind. */
export const LAUNCHER_ENTRY_FILES: Readonly<Record<ScriptKind, string>> = { sh: "launcher-entry.sh", cmd: "launcher-entry.cmd" };

/** What the launcher entry passes to `launch`. */
export interface EntrySpec {
  /** The data directory, absolute: where the launcher version file and the versions are, and what `launch` runs on. */
  readonly dataDir: string;
  readonly port: number;
  /** The name a new environment is created with; with none, `serve` takes the hostname. */
  readonly name?: string | undefined;
}

/** The command that writes the entry, quoted as the scripts' messages name it. */
const installCommand = `"${PRODUCT_NAME} service install"`;

/** A batch file's lines end with CRLF: cmd misreads labels in a file with bare line feeds. */
const batchFile = (lines: readonly string[]): string => `${lines.join("\r\n")}\r\n`;

const renderShEntry = ({ dataDir, port, name }: EntrySpec): string => {
  const [node, cli] = [versionNode("linux").join("/"), VERSION_CLI_ENTRY.join("/")];
  const launch = ["launch", "--data-dir", '"$data_dir"', "--port", String(port), ...(name === undefined ? [] : ["--name", shellWord(name)])];
  return [
    "#!/bin/sh",
    `# The ${PRODUCT_NAME} launcher entry. Written by ${installCommand};`,
    `# "${PRODUCT_NAME} service uninstall" removes it. The service definition runs it,`,
    "# and it starts the launcher of the version the launcher version file names.",
    "# With no such version it exits 0, which the service manager leaves stopped,",
    "# rather than failing again every few seconds.",
    `data_dir=${shellWord(dataDir)}`,
    "version=",
    `[ -r "$data_dir/${LAUNCHER_VERSION_FILE}" ] && IFS= read -r version < "$data_dir/${LAUNCHER_VERSION_FILE}"`,
    "case $version in",
    "  '' | .* | *[!0-9A-Za-z.+-]*)",
    `    echo "launcher entry: $data_dir/${LAUNCHER_VERSION_FILE} names no version, so no launcher starts; \\\`${PRODUCT_NAME} service install\\\` writes it." >&2`,
    "    exit 0",
    "    ;;",
    "esac",
    `dir="$data_dir/${VERSIONS_DIRECTORY}/$version"`,
    `if [ ! -f "$dir/${VERSION_SENTINEL}" ]; then`,
    `  echo "launcher entry: $version is not complete in $data_dir/${VERSIONS_DIRECTORY}, so no launcher starts; \\\`${PRODUCT_NAME} service install\\\` puts a version there." >&2`,
    "  exit 0",
    "fi",
    `exec "$dir/${node}" "$dir/${cli}" ${launch.join(" ")}`,
    "",
  ].join("\n");
};

const renderCmdEntry = ({ dataDir, port, name }: EntrySpec): string => {
  const version = `%DATA_DIR%\\${VERSIONS_DIRECTORY}\\%VERSION%`;
  const [node, cli] = [versionNode("win32").join("\\"), VERSION_CLI_ENTRY.join("\\")];
  const launch = ["launch", "--data-dir", batchArgument(dataDir), "--port", String(port), ...(name === undefined ? [] : ["--name", batchArgument(name)])];
  return batchFile([
    "@echo off",
    `rem The ${PRODUCT_NAME} launcher entry. Written by ${installCommand};`,
    `rem "${PRODUCT_NAME} service uninstall" removes it. The logon task runs it, and it`,
    "rem starts the launcher of the version the launcher version file names, again 5",
    "rem seconds after each non-zero exit (a crash, or a handover to a newer launcher),",
    "rem since Task Scheduler restarts a task only when it could not start it. With no",
    "rem such version it exits. The launcher's lines go to the service log. The line",
    "rem that runs the launcher ends in its own exits, since cmd reads this file by",
    "rem offset and install may replace it while the launcher runs.",
    "setlocal EnableExtensions DisableDelayedExpansion",
    `set "DATA_DIR=${batchSetValue(dataDir)}"`,
    `set "LOG=%DATA_DIR%\\${LOG_DIRECTORY}\\${LOG_FILE}"`,
    ":start",
    'set "VERSION="',
    `if exist "%DATA_DIR%\\${LAUNCHER_VERSION_FILE}" for /f "usebackq delims=" %%V in ("%DATA_DIR%\\${LAUNCHER_VERSION_FILE}") do if not defined VERSION set "VERSION=%%V"`,
    "if not defined VERSION goto no_version",
    `if not exist "${version}\\${VERSION_SENTINEL}" goto not_complete`,
    `"${version}\\${node}" "${version}\\${cli}" ${launch.join(" ")} >>"%LOG%" 2>&1 && exit /b 0 || goto restart`,
    ":restart",
    '>>"%LOG%" echo launcher entry: the launcher exited with code %ERRORLEVEL%, so it starts again in 5 s.',
    "ping -n 6 127.0.0.1 >nul",
    "goto start",
    ":no_version",
    `>>"%LOG%" echo launcher entry: "%DATA_DIR%\\${LAUNCHER_VERSION_FILE}" names no version, so no launcher starts; ${installCommand} writes it.`,
    "exit /b 0",
    ":not_complete",
    `>>"%LOG%" echo launcher entry: "%VERSION%" is not complete in "%DATA_DIR%\\${VERSIONS_DIRECTORY}", so no launcher starts; ${installCommand} puts a version there.`,
    "exit /b 0",
  ]);
};

/** The launcher entry of `kind` for `spec`. A data directory or name holding a line break is a `ServiceError`. */
export const renderLauncherEntry = (kind: ScriptKind, spec: EntrySpec): string => {
  oneLine("The data directory", spec.dataDir);
  if (spec.name !== undefined) oneLine("The environment's name", spec.name);
  return kind === "sh" ? renderShEntry(spec) : renderCmdEntry(spec);
};
