import type { ReleaseChannel, ReleaseSource } from "@agent-harness/contracts";

/**
 * Add a machine's Install on another machine (the Set up spec, "Add a
 * machine"; ADR 0025; launcher-update spec; #577), as every renderer shows
 * it: a copyable line per platform that fetches the install script from
 * the environment's own release and runs it with the environment's channel
 * and the name given (`install.sh` piped into `sh`, `install.ps1` made a
 * script block, as each runs), and the container's compose snippet with the
 * host-side updater's documentation. The repository is private, so each
 * fetch reads the token from `AGENT_HARNESS_TOKEN` and hands it to curl on
 * its standard input, as the scripts do, never on a command line; the
 * scripts read the same variable.
 */

/** What the lines install from and with. */
export interface InstallTarget {
  readonly releaseSource: ReleaseSource;
  /** The version whose release the script or the compose file is fetched from: the environment's own. */
  readonly version: string;
  readonly channel: ReleaseChannel;
  /** The new machine's name, passed to the script; none when blank. */
  readonly name: string;
}

export interface InstallLines {
  /** macOS and Linux. */
  readonly unix: string;
  /** Windows, in PowerShell. */
  readonly windows: string;
  /** The container: the release's compose file fetched, its registry logged in to, started, and its log read, one command a line. */
  readonly compose: readonly string[];
  /** The host-side updater's documentation at the release. */
  readonly updaterDocs: string;
}

/** A word as `sh` reads it back: bare when it is safe bare, else single-quoted. */
const shWord = (word: string): string => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

/** A word as PowerShell reads it back: bare when it is safe bare, else single-quoted. */
const powerShellWord = (word: string): string => (/^[A-Za-z0-9_./:-]+$/.test(word) ? word : `'${word.replaceAll("'", "''")}'`);

/** `curl` fetching from the forge with the token as a config line on its standard input, as `install.sh` does. */
const TOKEN_TO_CURL = `printf 'header = "Authorization: token %s"\\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL`;

/** The same in PowerShell, as `install.ps1` does. */
const TOKEN_TO_CURL_EXE = `('header = "Authorization: token ' + $env:AGENT_HARNESS_TOKEN + '"') | curl.exe -K - -fsSL`;

/** The lines that install a new machine from `target`'s release. */
export const installLines = (target: InstallTarget): InstallLines => {
  const { origin, repository, kind } = target.releaseSource;
  const release = `${origin}/${repository}/releases/download/v${target.version}`;
  const name = target.name.trim();
  const unixOptions = ["--channel", target.channel, ...(name === "" ? [] : ["--name", name])].map(shWord).join(" ");
  const windowsOptions = ["-Channel", target.channel, ...(name === "" ? [] : ["-Name", name])].map(powerShellWord).join(" ");
  return {
    unix: `${TOKEN_TO_CURL} ${release}/install.sh | sh -s -- ${unixOptions}`,
    windows: `& ([scriptblock]::Create((${TOKEN_TO_CURL_EXE} ${release}/install.ps1) -join "\`n")) ${windowsOptions}`,
    compose: [`${TOKEN_TO_CURL} -o compose.yaml ${release}/compose.yaml`, `docker login ${origin.replace(/^https?:\/\//, "")}`, "docker compose up -d", "docker compose logs environment"],
    updaterDocs: `${origin}/${repository}/${kind === "github" ? "blob" : "src/tag"}/v${target.version}/docs/host-updater.md`,
  };
};
