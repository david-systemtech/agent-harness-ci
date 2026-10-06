import { PRODUCT_NAME } from "@agent-harness/contracts";
import { HANDOVER_FILE, HANDOVER_STARTS_FILE, UNCONFIRMED_STARTS } from "../launch/handover.js";
import { LAUNCHER_VERSION_FILE } from "../launch/launcher-version.js";
import { SERVICE_LOG_VARIABLE } from "../launch/verb.js";
import { VERSION_CLI_ENTRY, VERSION_SENTINEL, versionNode, VERSIONS_DIRECTORY } from "../launch/versions.js";
import { batchArgument, batchSetValue, oneLine, shellWord } from "./quoting.js";
import { LOG_DIRECTORY, LOG_FILE } from "./spec.js";

/**
 * The launcher entry (launcher-update spec, "Versions and the launcher"): the
 * stable script in the data directory that the service definition runs. It
 * starts the launcher of the version the launcher version file names, that
 * version's own Node on its CLI, as `launch` with the data directory, the
 * port and the name, so a handover changes one line of a file and never the
 * definition. `service install` rewrites it whenever it runs.
 *
 * While the handover record names the launcher it starts as the one handed
 * over to (`handover.ts`), it counts each start in its start counter; once
 * `UNCONFIRMED_STARTS` went unconfirmed, it names the launcher that handed
 * over in the launcher version file again and starts that one instead. Those
 * two files are all it writes.
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
  /** The name a new environment is created with; with none, `serve` takes the hostname's first label. */
  readonly name?: string | undefined;
}

/** The command that writes the entry, quoted as the scripts' messages name it. */
const installCommand = `"${PRODUCT_NAME} service install"`;

/** How often the cmd entry tries to write its restart line, a second apart, while another process holds the service log. */
export const LOG_LINE_TRIES = 5;

/** A batch file's lines end with CRLF: cmd misreads labels in a file with bare line feeds. */
const batchFile = (lines: readonly string[]): string => `${lines.join("\r\n")}\r\n`;

const renderShEntry = ({ dataDir, port, name }: EntrySpec): string => {
  const [node, cli] = [versionNode("linux").join("/"), VERSION_CLI_ENTRY.join("/")];
  const launch = ["launch", "--data-dir", '"$data_dir"', "--port", String(port), ...(name === undefined ? [] : ["--name", shellWord(name)])];
  /** Replaces the data directory's `file` with `value` and a line feed, by a rename. */
  const replace = (file: string, value: string) => `printf '%s\\n' ${value} > "$data_dir/.${file}.tmp" && mv -f "$data_dir/.${file}.tmp" "$data_dir/${file}"`;
  return [
    "#!/bin/sh",
    `# The ${PRODUCT_NAME} launcher entry. Written by ${installCommand};`,
    `# "${PRODUCT_NAME} service uninstall" removes it. The service definition runs it,`,
    "# and it starts the launcher of the version the launcher version file names.",
    "# With no such version it exits 0, which the service manager leaves stopped,",
    "# rather than failing again every few seconds. It counts the starts of a",
    "# launcher handed over to until that launcher confirms, and after",
    `# ${UNCONFIRMED_STARTS} unconfirmed starts names the launcher that handed over again.`,
    `data_dir=${shellWord(dataDir)}`,
    "version=",
    `[ -r "$data_dir/${LAUNCHER_VERSION_FILE}" ] && IFS= read -r version < "$data_dir/${LAUNCHER_VERSION_FILE}"`,
    "case $version in",
    "  '' | .* | *[!0-9A-Za-z.+-]*)",
    `    echo "launcher entry: $data_dir/${LAUNCHER_VERSION_FILE} names no version, so no launcher starts; \\\`${PRODUCT_NAME} service install\\\` writes it." >&2`,
    "    exit 0",
    "    ;;",
    "esac",
    "from=",
    "to=",
    `[ -r "$data_dir/${HANDOVER_FILE}" ] && { IFS= read -r from; IFS= read -r to; } < "$data_dir/${HANDOVER_FILE}"`,
    "case $from in",
    "  '' | .* | *[!0-9A-Za-z.+-]*) from= ;;",
    "esac",
    'if [ -n "$from" ] && [ "$to" = "$version" ]; then',
    "  starts=",
    `  [ -r "$data_dir/${HANDOVER_STARTS_FILE}" ] && IFS= read -r starts < "$data_dir/${HANDOVER_STARTS_FILE}"`,
    "  case $starts in",
    "    '' | *[!0-9]*) starts=0 ;;",
    "  esac",
    `  if [ "$starts" -ge ${UNCONFIRMED_STARTS} ]; then`,
    '    echo "launcher entry: the launcher of $to was started $starts times without confirming that its child passed the gate, so the launcher of $from starts again." >&2',
    `    ${replace(LAUNCHER_VERSION_FILE, '"$from"')}`,
    "    version=$from",
    "  else",
    `    ${replace(HANDOVER_STARTS_FILE, '"$((starts + 1))"')}`,
    "  fi",
    "fi",
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
  /** Replaces the data directory's `file` with `value`, by a rename. */
  const replace = (file: string, value: string) => [
    `>"%DATA_DIR%\\.${file}.tmp" echo ${value}`,
    `move /y "%DATA_DIR%\\.${file}.tmp" "%DATA_DIR%\\${file}" >nul`,
  ];
  const [node, cli] = [versionNode("win32").join("\\"), VERSION_CLI_ENTRY.join("\\")];
  const launch = ["launch", "--data-dir", batchArgument(dataDir), "--port", String(port), ...(name === undefined ? [] : ["--name", batchArgument(name)])];
  return batchFile([
    "@echo off",
    `rem The ${PRODUCT_NAME} launcher entry. Written by ${installCommand};`,
    `rem "${PRODUCT_NAME} service uninstall" removes it. The logon task runs it, and it`,
    "rem starts the launcher of the version the launcher version file names, again 5",
    "rem seconds after each non-zero exit (a crash, or a handover to a newer launcher),",
    "rem since Task Scheduler restarts a task only when it could not start it. With no",
    "rem such version it exits. The launcher writes the service log itself, which",
    `rem ${SERVICE_LOG_VARIABLE} names: cmd holds a file it redirects to for itself`,
    "rem alone, so a second launcher could not start while one ran, nor say why. Its",
    "rem restart line it tries again for a few seconds while another holds the log.",
    "rem The line that runs the launcher ends in its own exits, since cmd reads this file by",
    "rem offset and install may replace it while the launcher runs. It counts the",
    "rem starts of a launcher handed over to until that launcher confirms, and after",
    `rem ${UNCONFIRMED_STARTS} unconfirmed starts names the launcher that handed over again.`,
    "setlocal EnableExtensions DisableDelayedExpansion",
    `set "DATA_DIR=${batchSetValue(dataDir)}"`,
    `set "LOG=%DATA_DIR%\\${LOG_DIRECTORY}\\${LOG_FILE}"`,
    `set "${SERVICE_LOG_VARIABLE}=%LOG%"`,
    ":start",
    'set "VERSION="',
    // Search for forbidden characters before cmd expands a value. Avoid /x and $, which reject LF-only files.
    `if exist "%DATA_DIR%\\${LAUNCHER_VERSION_FILE}" findstr /r "[^0-9A-Za-z.+-]" "%DATA_DIR%\\${LAUNCHER_VERSION_FILE}" >nul && goto no_version`,
    `if exist "%DATA_DIR%\\${LAUNCHER_VERSION_FILE}" for /f "usebackq delims=" %%V in ("%DATA_DIR%\\${LAUNCHER_VERSION_FILE}") do if not defined VERSION set "VERSION=%%V"`,
    "if not defined VERSION goto no_version",
    'set "FROM="',
    'set "TO="',
    // The same check keeps a handover record with any other line from being read at all.
    `if exist "%DATA_DIR%\\${HANDOVER_FILE}" findstr /r "[^0-9A-Za-z.+-]" "%DATA_DIR%\\${HANDOVER_FILE}" >nul || for /f "usebackq delims=" %%L in ("%DATA_DIR%\\${HANDOVER_FILE}") do if not defined FROM (set "FROM=%%L") else if not defined TO set "TO=%%L"`,
    "if not defined TO goto run",
    'if not "%TO%"=="%VERSION%" goto run',
    'set "STARTS=0"',
    `if exist "%DATA_DIR%\\${HANDOVER_STARTS_FILE}" findstr /r "[^0-9]" "%DATA_DIR%\\${HANDOVER_STARTS_FILE}" >nul || for /f "usebackq delims=" %%N in ("%DATA_DIR%\\${HANDOVER_STARTS_FILE}") do set /a "STARTS=%%N"`,
    `if %STARTS% GEQ ${UNCONFIRMED_STARTS} goto fall_back`,
    'set /a "STARTS+=1"',
    ...replace(HANDOVER_STARTS_FILE, "%STARTS%"),
    "goto run",
    ":fall_back",
    '>>"%LOG%" echo launcher entry: the launcher of %TO% was started %STARTS% times without confirming that its child passed the gate, so the launcher of %FROM% starts again.',
    ...replace(LAUNCHER_VERSION_FILE, "%FROM%"),
    'set "VERSION=%FROM%"',
    ":run",
    `if not exist "${version}\\${VERSION_SENTINEL}" goto not_complete`,
    `"${version}\\${node}" "${version}\\${cli}" ${launch.join(" ")} && exit /b 0 || goto restart`,
    ":restart",
    'set "CODE=%ERRORLEVEL%"',
    'set "TRIES=0"',
    ":restart_line",
    'set /a "TRIES+=1"',
    `(>>"%LOG%" echo launcher entry: the launcher exited with code %CODE%, so it starts again in 5 s.) 2>nul || (if %TRIES% LSS ${LOG_LINE_TRIES} (ping -n 2 127.0.0.1 >nul & goto restart_line))`,
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
