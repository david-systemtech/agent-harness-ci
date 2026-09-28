import { PRODUCT_NAME } from "@agent-harness/contracts";
import { SERVICE_STATE_FILE } from "../launch/state.js";
import { VERSION_CLI_ENTRY, VERSION_SENTINEL, versionNode, VERSIONS_DIRECTORY } from "../launch/versions.js";
import type { ScriptKind } from "./entry.js";
import { batchSetValue, oneLine, shellDoubleQuoted, shellWord } from "./quoting.js";

/**
 * The shim (launcher-update spec, "Versions and the launcher"): the
 * `agent-harness` in the data directory's `bin` folder. It runs the
 * `agent-harness` of the version the service state names active, with the
 * arguments it was given, so whatever runs it (a person's terminal UI, a
 * credential helper) always matches its environment, through every update,
 * at one path that never changes. It reads the state at each run; the
 * launcher writes it as JSON with the active version on a line of its own.
 */

/** The data directory's folder the shim is in, which a person puts on their PATH. */
export const SHIM_DIRECTORY = "bin";

/** The shim's file in `SHIM_DIRECTORY`, by kind: the product's name, which `cmd` finds as a command with the `.cmd` extension. */
export const SHIM_FILES: Readonly<Record<ScriptKind, string>> = { sh: PRODUCT_NAME, cmd: `${PRODUCT_NAME}.cmd` };

/** The command that writes the shim and the service state it reads, as the shim's messages name it. */
const installCommand = `${PRODUCT_NAME} service install`;

const renderShShim = (dataDir: string): string =>
  [
    "#!/bin/sh",
    `# ${PRODUCT_NAME}: runs the ${PRODUCT_NAME} of the version the service state below`,
    "# names active, with the arguments it was given. Written by",
    `# "${installCommand}"; "${PRODUCT_NAME} service uninstall" removes it.`,
    `data_dir=${shellWord(dataDir)}`,
    `version=$(sed -n 's/.*"activeVersion"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$data_dir/${SERVICE_STATE_FILE}" 2>/dev/null | head -n 1)`,
    "case $version in",
    "  '' | .* | *[!0-9A-Za-z.+-]*)",
    `    echo "${PRODUCT_NAME}: the service state in $data_dir names no active version; \\\`${installCommand}\\\` writes it." >&2`,
    "    exit 1",
    "    ;;",
    "esac",
    `dir="$data_dir/${VERSIONS_DIRECTORY}/$version"`,
    `if [ ! -f "$dir/${VERSION_SENTINEL}" ]; then`,
    `  echo "${PRODUCT_NAME}: the active version $version is not complete in $data_dir/${VERSIONS_DIRECTORY}." >&2`,
    "  exit 1",
    "fi",
    `exec "$dir/${versionNode("linux").join("/")}" "$dir/${VERSION_CLI_ENTRY.join("/")}" "$@"`,
    "",
  ].join("\n");

const renderCmdShim = (dataDir: string): string => {
  const version = `%DATA_DIR%\\${VERSIONS_DIRECTORY}\\%VERSION%`;
  const state = `%DATA_DIR%\\${SERVICE_STATE_FILE}`;
  return `${[
    "@echo off",
    `rem ${PRODUCT_NAME}: runs the ${PRODUCT_NAME} of the version the service state below`,
    "rem names active, with the arguments it was given. Written by",
    `rem "${installCommand}"; "${PRODUCT_NAME} service uninstall" removes it.`,
    "setlocal EnableExtensions DisableDelayedExpansion",
    `set "DATA_DIR=${batchSetValue(dataDir)}"`,
    'set "VERSION="',
    `if exist "${state}" for /f "usebackq tokens=2 delims=:, " %%V in (\`findstr /l /c:"activeVersion" "${state}"\`) do if not defined VERSION set "VERSION=%%~V"`,
    "if not defined VERSION goto no_version",
    `if not exist "${version}\\${VERSION_SENTINEL}" goto not_complete`,
    `"${version}\\${versionNode("win32").join("\\")}" "${version}\\${VERSION_CLI_ENTRY.join("\\")}" %*`,
    "exit /b %ERRORLEVEL%",
    ":no_version",
    `1>&2 echo ${PRODUCT_NAME}: the service state in "%DATA_DIR%" names no active version; "${installCommand}" writes it.`,
    "exit /b 1",
    ":not_complete",
    `1>&2 echo ${PRODUCT_NAME}: the active version "%VERSION%" is not complete in "%DATA_DIR%\\${VERSIONS_DIRECTORY}".`,
    "exit /b 1",
  ].join("\r\n")}\r\n`;
};

/** The shim of `kind` for the data directory `dataDir`. A data directory holding a line break is a `ServiceError`. */
export const renderShim = (kind: ScriptKind, dataDir: string): string => {
  oneLine("The data directory", dataDir);
  return kind === "sh" ? renderShShim(dataDir) : renderCmdShim(dataDir);
};

/**
 * The line a person runs to put `binDirectory` on their PATH, since install
 * edits no profile: for `sh`, an export for their shell's profile; for `cmd`,
 * a PowerShell line that puts it first on their user Path.
 */
export const pathLine = (kind: ScriptKind, binDirectory: string): string =>
  kind === "sh"
    ? `export PATH="${shellDoubleQuoted(binDirectory)}:$PATH"`
    : `[Environment]::SetEnvironmentVariable('Path', '${binDirectory.replaceAll("'", "''")};' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')`;
