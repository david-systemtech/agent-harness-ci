/**
 * What the two install scripts' tests share (`install-script.test.ts` for
 * `install.sh`, `install-ps1-script.test.ts` for `install.ps1`): the forge's
 * and the environment's URLs, a fake inherited token, a public release as the API lists
 * it, and a fake `curl` that serves them. Nothing here touches the network.
 */
import { chmodSync, writeFileSync } from "node:fs";

export const FORGE = "https://github.com";
export const API = "https://api.github.com/repos/david-systemtech/agent-harness/releases";
export const LIST = `${API}?per_page=50`;
export const DOWNLOAD = `${FORGE}/david-systemtech/agent-harness/releases/download`;
export const ENVIRONMENT = "http://127.0.0.1:7433";
export const HEALTH = `${ENVIRONMENT}/health`;
export const DISCOVERY = `${ENVIRONMENT}/.well-known/agent-harness/environment`;
export const TOKEN = "token-for-tests";

export const write = (path: string, text: string, mode = 0o644) => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};

/**
 * A fake curl: logs its URL; for the public release, refuses authentication
 * and serves the fake release, to `-o`'s file when given, else to stdout; for
 * the environment's own URLs, refuses the token and answers health and
 * discovery while the fake service runs, health failing to connect for its
 * first FAKE_UNANSWERED_PROBES probes, as before the service binds its port,
 * and saying `starting` for its first FAKE_STARTING_PROBES. Its environment:
 * FAKE_LOG, the calls' log; FAKE_STATE, the fake service's folder (`running`, `probes`);
 * FAKE_RELEASES, the API's answers (`list.json`, `<tag>.json`); FAKE_ASSETS,
 * the downloads (`<tag>/<name>`); FAKE_RELEASE_ERROR; FAKE_AUTH_POLICY.
 */
export const FAKE_CURL = `#!/bin/sh
out=""
url=""
with_config=0
while [ $# -gt 0 ]; do
  case $1 in
    -o | --max-time) [ "$1" = -o ] && out=$2; shift 2 ;;
    -K) cat >/dev/null; with_config=1; shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'curl %s\\n' "$url" >> "$FAKE_LOG"
case $url in
  http://127.0.0.1:*)
    [ "$with_config" = 0 ] || { echo "curl: the forge token was sent to $url" >&2; exit 99; }
    [ -f "$FAKE_STATE/running" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
    case $url in
      */health)
        probes=$(( $(cat "$FAKE_STATE/probes" 2>/dev/null || echo 0) + 1 ))
        echo "$probes" > "$FAKE_STATE/probes"
        [ "$probes" -gt "\${FAKE_UNANSWERED_PROBES:-0}" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
        if [ "$probes" -gt "\${FAKE_STARTING_PROBES:-0}" ]; then status=ready; else status=starting; fi
        printf '{"status":"%s","version":"0.1.0"}' "$status" ;;
      */.well-known/agent-harness/environment)
        printf '{"environmentId":"env-for-tests","environmentName":"box","authPolicy":"%s","readiness":"ready"}' "\${FAKE_AUTH_POLICY:-tailnet}" ;;
      *) echo "curl: (22) The requested URL returned error: 404" >&2; exit 22 ;;
    esac
    exit 0 ;;
esac
[ "$with_config" = 0 ] || { echo "curl: a credential was sent to a public release" >&2; exit 99; }
[ -z "\${FAKE_RELEASE_ERROR:-}" ] || { echo "curl: (22) The requested URL returned error: $FAKE_RELEASE_ERROR" >&2; exit 22; }
case $url in
  https://api.github.com/*)
    [ -z "\${FAKE_API_ERROR:-}" ] || { echo "curl: (22) The requested URL returned error: $FAKE_API_ERROR" >&2; exit 22; } ;;
esac
case $url in
  */releases/latest/download/release.json) answer="$FAKE_RELEASES/latest-manifest.json" ;;
  *"/releases?per_page=50") answer="$FAKE_RELEASES/list.json" ;;
  */releases/tags/*) answer="$FAKE_RELEASES/\${url##*/}.json" ;;
  */releases/download/*) answer="$FAKE_ASSETS/\${url#*/releases/download/}" ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
[ -f "$answer" ] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
if [ -n "$out" ]; then cp "$answer" "$out"; else cat "$answer"; fi
`;

/** A release to list: its tag, whether it is a draft or a prerelease, and what it publishes. */
export interface ReleaseSpec {
  readonly tag: string;
  readonly draft?: boolean;
  readonly prerelease?: boolean;
  /** The published digest: the artefact's, another, or none published. Preset: the artefact's. */
  readonly checksum?: "right" | "wrong" | "none";
  /** The artefact's name, when not the platform's the test installs on. */
  readonly assetName?: string;
  /** An artefact without the version's CLI in it. */
  readonly withoutBinary?: boolean;
}

/** A release as the forge's API answers it, publishing `assets`, with notes that hold what a line-by-line reader could mistake for members. */
export const releaseJson = (spec: ReleaseSpec, assets: readonly string[]) => ({
  id: 7,
  tag_name: spec.tag,
  target_commitish: "main",
  name: `agent-harness ${spec.tag}`,
  body: 'Notes, with commas, and a quoted \\"tag_name\\": \\"v6.6.6\\" and \\"draft\\": true in them.',
  url: `${API}/7`,
  draft: spec.draft ?? false,
  prerelease: spec.prerelease ?? false,
  author: { id: 1, login: "david" },
  assets: assets.map((name, i) => ({ id: 10 + i, name, size: 1, browser_download_url: `${DOWNLOAD}/${spec.tag}/${name}` })),
});
