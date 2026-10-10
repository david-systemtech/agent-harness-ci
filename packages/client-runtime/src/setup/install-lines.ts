import { NEW_ENVIRONMENT_CHANNEL_VARIABLE, NEW_ENVIRONMENT_NAME_VARIABLE, type ReleaseChannel, type ReleaseSource } from "@agent-harness/contracts";

/**
 * Add a device's Install agent-harness on another computer (setup-copy.md
 * §5.5; ADR 0025; launcher-update spec; #577, #1847), as every renderer shows
 * it: a copyable line per platform that fetches the install script from
 * the environment's own release and runs it with the environment's channel
 * and the name given (`install.sh` piped into `sh`, `install.ps1` made a
 * script block, as each runs), and the container's compose snippet, whose
 * `docker compose up -d` gives the same two to the container's first start
 * (#846), with the host-side updater and its documentation. Public GitHub
 * releases are fetched anonymously; private forge releases read the token
 * from `AGENT_HARNESS_TOKEN` on curl's standard input.
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
  /** The container: the release's compose file and updater fetched, started with the channel and the name for its first start, and its log read, one command a line. */
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
  const composeVariables = [`${NEW_ENVIRONMENT_CHANNEL_VARIABLE}=${shWord(target.channel)}`, ...(name === "" ? [] : [`${NEW_ENVIRONMENT_NAME_VARIABLE}=${shWord(name)}`])].join(" ");
  const curl = kind === "github" ? "curl -fsSL" : TOKEN_TO_CURL;
  const curlExe = kind === "github" ? "curl.exe -fsSL" : TOKEN_TO_CURL_EXE;
  return {
    unix: `${curl} ${release}/install.sh | sh -s -- ${unixOptions}`,
    windows: `& ([scriptblock]::Create((${curlExe} ${release}/install.ps1) -join "\`n")) ${windowsOptions}`,
    compose: [
      `${curl} -o compose.yaml ${release}/compose.yaml`,
      `${curl} -o host-updater.sh ${release}/host-updater.sh`,
      "chmod +x host-updater.sh",
      ...(kind === "github" ? [] : [`docker login ${origin.replace(/^https?:\/\//, "")}`]),
      `${composeVariables} docker compose up -d`,
      "docker compose logs environment",
    ],
    updaterDocs: `${origin}/${repository}/${kind === "github" ? "blob" : "src/tag"}/v${target.version}/docs/host-updater.md`,
  };
};
