#!/usr/bin/env bash
# The `ci` job's relay to GitHub. The checks themselves run on GitHub's free
# public-repository runners in david-systemtech/agent-harness-ci (its
# .github/workflows/ci.yml has the steps and the reasons); this job only hands
# the commit over and waits, so it uses almost no CPU on the homelab.
#
# 1. Scan the commit's history for secrets here, before anything leaves the
#    homelab: agent-harness-ci is public, and a pushed commit stays fetchable.
#    Then push it to GitHub as refs/heads/ci/<id>, with origin/main as
#    `mirror/main` so each push sends only the objects GitHub lacks. Never
#    `main`: repository_dispatch reads its workflow from the default branch,
#    `workflows`, and must never be pointed at a copy of this tree.
# 2. Send a repository_dispatch carrying the sha, the id and a concurrency group.
# 3. Find the run by its title, wait for it, and exit with its verdict. A failed
#    run's failed steps are printed here, so the Forgejo log stays readable.
#    The run's last job deletes ci/<id>.
#
# Needs GH_CI_TOKEN: a fine-grained token for agent-harness-ci, with Contents
# read/write (the push, and repository_dispatch) and Actions read (the run). GROUP is the pull request number or,
# on main, the commit, so a newer push to a pull request cancels the older run on GitHub as it does here and
# every main run finishes.
set -euo pipefail

: "${GH_CI_TOKEN:?GH_CI_TOKEN is not set}" "${GROUP:?}" "${FORGEJO_RUN:=}"
repo=${GH_CI_REPO:-david-systemtech/agent-harness-ci}
api=https://api.github.com/repos/$repo
sha=$(git rev-parse HEAD)
id="$(date -u +%Y%m%d%H%M%S)-${sha:0:12}-$RANDOM"
group=$(printf '%s' "$GROUP" | tr -c 'A-Za-z0-9._-' '-')
# A separate network job shares the transport, not the unit suite.
event=${GH_CI_EVENT:-ci}
case "$event" in ci | catalogue | gallery) ;; *) echo "::error::unknown CI event"; exit 1 ;; esac

# Each attempt has 120 s, enough for a 16 KB run reply at the site's measured 1.2 KB/s.
# Retries start within 180 s; the last attempt can take another 120 s.
gh_api() {
  curl -sS --connect-timeout 15 --max-time 120 --retry 5 --retry-delay 3 --retry-max-time 180 --retry-all-errors -H @<(printf 'Authorization: Bearer %s\n' "$GH_CI_TOKEN") \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}
# A GET whose reply gets parsed. Through a file, because curl cannot rewind stdout: a retry after
# a reply cut off mid-way appended the new reply to the partial one, and the parse then failed the
# job (2026-10-02). Failed transfers and incomplete JSON never reach the callers' parsers.
gh_get() {
  local out
  out=$(mktemp -p "$gl")
  if ! gh_api --fail -o "$out" "$@" || ! python3 -c '
import json,sys
try:
    with open(sys.argv[1]) as f: reply=json.load(f)
    if not isinstance(reply,dict): sys.exit(1)
except ValueError: sys.exit(1)
' "$out"; then
    rm -f "$out"
    return 1
  fi
  cat "$out"
  rm -f "$out"
}

# Three failed polls cost at most 15 minutes of API transport, within the 40-minute
# relay budget. A valid reply resets the count, even when the run is still queued.
transport_failures=0
transport_failure() {
  transport_failures=$((transport_failures + 1))
  if [ "$transport_failures" -ge 3 ]; then
    echo "::error::GitHub API transport failed: GET $1 (3 consecutive failed or incomplete replies after retries)"
    exit 1
  fi
}

# The same gitleaks pin as david/ci scripts/secret-scan.sh; only HEAD's history.
gl_version=8.30.1
case "$(uname -m)" in
  x86_64) gl_arch=x64 gl_sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  aarch64 | arm64) gl_arch=arm64 gl_sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) echo "::error::No gitleaks build pinned for $(uname -m)"; exit 1 ;;
esac
gl=$(mktemp -d)
trap 'rm -rf "$gl"' EXIT
gl_url=https://github.com/gitleaks/gitleaks/releases/download/v$gl_version/gitleaks_${gl_version}_linux_$gl_arch.tar.gz
# A checked download is kept in the runner's tool cache, keyed by version and
# pin, for the next run (#1096). Every use copies it into this job's folder
# and checks that copy, so a damaged or swapped file costs a download, never
# another binary. The `relay` runner keeps that folder only once it mounts a
# volume there (#1098); until then each run downloads.
gl_kept=${RUNNER_TOOL_CACHE:-$HOME/.cache}/gitleaks/$gl_version/$gl_sum.tar.gz
if cp "$gl_kept" "$gl/g.tgz" 2>/dev/null && echo "$gl_sum  $gl/g.tgz" | sha256sum -c --status -; then
  echo "gitleaks $gl_version: the copy kept at $gl_kept"
elif [ -n "${FORGEJO_TOKEN:-}" ] &&
  curl -sSfL --connect-timeout 10 --max-time 60 -H @<(printf 'Authorization: token %s\n' "$FORGEJO_TOKEN") \
    -o "$gl/g.tgz" "${FORGEJO_URL:-https://git.systemtech.dev:5526}/api/packages/david/generic/gitleaks/$gl_version/gitleaks_${gl_version}_linux_$gl_arch.tar.gz" 2>/dev/null &&
  echo "$gl_sum  $gl/g.tgz" | sha256sum -c --status -; then
  # The same pinned build, kept in this Forgejo's generic package registry
  # (linked to the repository, so the job's own token reads it): the site's
  # uplink fell back to Wi-Fi on 2026-10-02 and GitHub's release downloads
  # stalled at a few hundred bytes a second. The checksum above still decides.
  echo "gitleaks $gl_version: the copy in Forgejo's package registry"
else
  # GitHub's release downloads answered 504 for minutes on 2026-10-01 (#1096),
  # past curl's default backoff of 1, 2 and 4 s: so 5 s apart for up to two
  # minutes, any error included, and a minute at most for each try.
  curl -sSfL --connect-timeout 20 --max-time 60 --retry 12 --retry-delay 5 --retry-max-time 120 --retry-all-errors \
    -o "$gl/g.tgz" "$gl_url" ||
    { echo "::error::Could not download gitleaks $gl_version from $gl_url, so no check ran; run the job again"; exit 1; }
  echo "$gl_sum  $gl/g.tgz" | sha256sum -c --status - ||
    { echo "::error::The download of gitleaks $gl_version from $gl_url is not the pinned build $gl_sum, so no check ran"; exit 1; }
  # Kept if the folder takes it (a run that cannot write it only downloads),
  # under a name of its own and then renamed, as up to eight relays share it.
  part=
  if mkdir -p "${gl_kept%/*}" 2>/dev/null && part=$(mktemp "$gl_kept.XXXXXX" 2>/dev/null) &&
    cp "$gl/g.tgz" "$part" 2>/dev/null && mv -f "$part" "$gl_kept" 2>/dev/null; then :
  elif [ -n "$part" ]; then rm -f "$part"; fi
fi
tar -xzf "$gl/g.tgz" -C "$gl" gitleaks
"$gl/gitleaks" git --no-banner --redact --exit-code 1 --log-opts="HEAD" . ||
  { echo "::error::gitleaks found a secret; nothing was pushed to GitHub"; exit 1; }

echo "Pushing $sha to $repo as ci/$id"
auth=(-c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GH_CI_TOKEN"; }; f')
export GH_CI_TOKEN GIT_TERMINAL_PROMPT=0
# GitHub sometimes rejects a push while other relays push at once ("[remote rejected] ... (failed)",
# main run 3778 on 2026-10-01, in a burst of six merges in three minutes), so try it three times.
for try in 1 2 3; do
  git "${auth[@]}" push --quiet "https://github.com/$repo.git" "+$sha:refs/heads/ci/$id" && break
  [ "$try" = 3 ] && { echo "::error::GitHub rejected the push of ci/$id three times"; exit 1; }
  echo "push rejected; trying again in $((try * 10)) s"; sleep $((try * 10))
done
# The anchor in its own push, and allowed to fail: two relays at once race
# for it ("cannot lock ref"), and in one push that failed the run's ref too.
if git rev-parse -q --verify origin/main >/dev/null; then
  git "${auth[@]}" push --quiet "https://github.com/$repo.git" "+$(git rev-parse origin/main):refs/heads/mirror/main" ||
    echo "mirror/main not moved (another relay moved it); the next push will"
fi

payload=$(python3 -c 'import json,sys; print(json.dumps({"event_type":sys.argv[5],"client_payload":{"sha":sys.argv[1],"id":sys.argv[2],"group":sys.argv[3],"forgejo_run":sys.argv[4]}}))' \
  "$sha" "$id" "$group" "$FORGEJO_RUN" "$event")
# Runs created from a minute before the dispatch, so the lookup reads a few runs, not 30
# (30 were 485 KB, which a slow uplink did not finish in two minutes).
since=$(python3 -c 'import datetime as d; print((d.datetime.now(d.timezone.utc) - d.timedelta(minutes=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
code=$(gh_api -o /dev/null -w '%{http_code}' -X POST "$api/dispatches" -d "$payload") ||
  { echo "::error::GitHub API transport failed: POST $api/dispatches (retries exhausted)"; exit 1; }
[ "$code" = 204 ] || { echo "::error::repository_dispatch answered HTTP $code"; exit 1; }

title="$event $sha $id"
run_id=
run_url="$api/actions/runs?event=repository_dispatch&created=%3E%3D$since&per_page=30"
for _ in $(seq 1 30); do
  sleep 5
  if reply=$(gh_get "$run_url"); then transport_failures=0
  else transport_failure "$run_url"; continue; fi
  run_id=$(printf '%s' "$reply" | python3 -c '
import json,sys
try: runs=json.load(sys.stdin).get("workflow_runs",[])
except ValueError: runs=[]
print(next((str(r["id"]) for r in runs if r.get("display_title")==sys.argv[1]),""))' "$title")
  [ -n "$run_id" ] && break
done
[ -n "$run_id" ] || { echo "::error::no GitHub run appeared for $title within 150 s"; exit 1; }
echo "GitHub run: https://github.com/$repo/actions/runs/$run_id"

while :; do
  if reply=$(gh_get "$api/actions/runs/$run_id"); then transport_failures=0
  else transport_failure "$api/actions/runs/$run_id"; sleep 15; continue; fi
  read -r status conclusion < <(printf '%s' "$reply" | python3 -c '
import json,sys
try: r=json.load(sys.stdin)
except ValueError: r={}
print(r.get("status") or "unknown", r.get("conclusion") or "-")')
  [ "$status" = completed ] && break
  sleep 15
done
echo "GitHub run finished: $conclusion"
# Failed comparisons still publish the captures, baseline and difference for review.
if [ "$event" = gallery ] && [[ "$conclusion" == success || "$conclusion" == failure ]]; then
  reply=$(gh_get "$api/actions/runs/$run_id/artifacts?per_page=100")
  artifact=$(printf '%s' "$reply" | python3 -c '
import json,sys
items=[a for a in json.load(sys.stdin).get("artifacts",[]) if a["name"]=="window-gallery" and not a.get("expired")]
if not items: sys.exit(0)
if len(items)!=1 or items[0]["size_in_bytes"]>32*1024*1024: sys.exit("oversized or duplicate gallery artifact")
print(int(items[0]["id"]))')
  if [ -z "$artifact" ]; then
    echo "No gallery artifact was uploaded; reading the failed job logs."
    [ "$conclusion" != success ] || { echo "::error::successful gallery run has no artifact"; exit 1; }
  else
    gh_api --fail -L --max-filesize 33554432 -o "$gl/gallery.zip" "$api/actions/artifacts/$artifact/zip"
    if python3 - "$gl/gallery.zip" <<'PYLEGACY'
import sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z: sys.exit(0 if 'report.json' not in z.namelist() else 1)
PYLEGACY
    then
      # A workflow rollout can finish an earlier capture-only artifact.
      bash "$(dirname "${BASH_SOURCE[0]}")/gallery-comment.sh" "$gl/gallery.zip" "$sha"
    else
      python3 - "$gl/gallery.zip" "$sha" <<'PYGALLERY'
import hashlib, html, json, os, re, sys, urllib.error, urllib.parse, urllib.request, zipfile
base = os.environ['FORGEJO_URL'].rstrip('/')
repository = os.environ['FORGEJO_REPOSITORY']; pr = os.environ['FORGEJO_PR']; head = sys.argv[2]
if not re.fullmatch(r'[1-9][0-9]*', pr) or not re.fullmatch(r'[A-Za-z0-9._-]+/[A-Za-z0-9._-]+', repository): sys.exit('Invalid gallery destination')
api = f'{base}/api/v1/repos/{repository}'
package_token = os.environ.get('PACKAGES_TOKEN') or os.environ['FORGEJO_TOKEN']
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs): return None
opener = urllib.request.build_opener(NoRedirect())
def absolute_request(url, method='GET', data=None, content_type='application/json', package=False):
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'token ' + (package_token if package else os.environ['FORGEJO_TOKEN']), 'Content-Type': content_type})
    with opener.open(req, timeout=120) as response:
        reply = response.read()
        return json.loads(reply) if reply else None
def request(path, method='GET', data=None, content_type='application/json'):
    return absolute_request(api + path, method, data, content_type)
current = request(f'/pulls/{pr}')
if current['state'] != 'open' or current.get('merged') or current['head']['sha'] != head: sys.exit(2)
with zipfile.ZipFile(sys.argv[1]) as z:
    entries = z.infolist()
    if len(entries) > 602 or sum(f.file_size for f in entries) > 24*1024*1024: sys.exit('gallery payload is too large')
    names = [f.filename for f in entries]
    if len(set(names)) != len(names) or any(not re.fullmatch(r'[a-z0-9-]+[.](dark|light)([.](baseline|difference))?[.]png|report[.]json|geometry[.]json', n) for n in names): sys.exit('unexpected gallery entry')
    report = json.loads(z.read('report.json'))
    images = {n: z.read(n) for n in names if n.endswith('.png')}
    for data in images.values():
        if not data.startswith(b'\x89PNG\r\n\x1a\n'): sys.exit('gallery entry is not a PNG')
    scenes = report['scenes']
    if not scenes or len(scenes) > 200: sys.exit('invalid gallery scene list')
    seen = set()
    for scene in scenes:
        name = scene['name']
        if not re.fullmatch(r'[a-z0-9-]+[.](dark|light)', name) or name in seen: sys.exit('invalid gallery scene name')
        seen.add(name)
        required = [name + '.png']
        if scene['status'] == 'changed': required += [name + '.baseline.png', name + '.difference.png']
        if scene['status'] not in ('new', 'changed', 'unchanged') or any(n not in images for n in required): sys.exit('incomplete gallery triplet')
comment = request(f'/issues/{pr}/comments', 'POST', json.dumps({'body': f'Window gallery for `{head}`. Uploading captures…'}).encode())['id']
stage = 'uploads'
try:
    version = f'{head}-{comment}'
    urls = {}
    for name, data in sorted(images.items()):
        stage = f'attachment {name}'
        boundary = 'gallery-upload-boundary'
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="{name}"\r\nContent-Type: image/png\r\n\r\n'.encode() + data + f'\r\n--{boundary}--\r\n'.encode())
        asset = request(f'/issues/comments/{comment}/assets', 'POST', body, f'multipart/form-data; boundary={boundary}')
        url = asset['browser_download_url']; parsed = urllib.parse.urlsplit(url); origin = urllib.parse.urlsplit(base)
        if (parsed.scheme, parsed.netloc) != (origin.scheme, origin.netloc) or not parsed.path.startswith('/attachments/') or any(c in url for c in '\n\r()'): raise ValueError('invalid asset URL')
        urls[name] = url
    body = f'Window gallery for `{head}` (1400 × 900; narrow 1024 × 768; light and dark).\n'
    geometry_failed = any(s['geometryFailures'] for s in scenes)
    pixel_failed = any(s['pixelFailed'] for s in scenes)
    body += f"\nGeometry: {'failed' if geometry_failed else 'passed'}. Pixels: {'blocking' if report['pixelBlocking'] else 'advisory'}; {'differences' if pixel_failed else 'passed'}.\n"
    matched = sum(s['status'] == 'unchanged' for s in scenes)
    body += f'\n{matched} scene{"" if matched == 1 else "s"} matched.\n'
    for scene in scenes:
        name = scene['name']
        if scene['status'] == 'changed':
            body += f'\n**{name}**\n\n| Baseline | Capture | Difference |\n| --- | --- | --- |\n'
            body += '| ' + ' | '.join(f'![{kind} {name}]({urls[name+suffix]})' for kind,suffix in [('baseline','.baseline.png'),('capture','.png'),('difference','.difference.png')]) + ' |\n'
        elif scene['status'] == 'new' or scene['geometryFailures']:
            body += f'\n**{name}** ({scene["status"]})\n\n![capture {name}]({urls[name+".png"]})\n'
        for failure in scene['geometryFailures']: body += f'\n- {html.escape(failure)}\n'
    # The web attachment route can be behind SSO while the tracker API accepts tokens.
    # Publish capture bytes through the generic package API too, so acceptance needs no browser cookie.
    captures = []
    for scene in scenes:
        name = scene['name'] + '.png'
        stage = f'capture storage {name}'
        download = f'{base}/api/packages/{repository.split("/")[0]}/generic/window-gallery/{version}/{name}'
        try: absolute_request(download, 'PUT', images[name], 'image/png', package=True)
        except urllib.error.HTTPError as error:
            if error.code != 409: raise
            # Reusing this report version is safe only when its bytes are identical.
            req = urllib.request.Request(download, headers={'Authorization': 'token ' + package_token})
            with opener.open(req, timeout=120) as response:
                if response.read(4*1024*1024+1) != images[name]: raise ValueError('Existing gallery capture has different bytes')
        captures.append({'name': name, 'url': urls[name], 'api_url': download, 'sha256': hashlib.sha256(images[name]).hexdigest()})
    manifest = {'head': head, 'version': version, 'captures': captures}
    body += '\n<!-- window-gallery ' + json.dumps(manifest) + ' -->\n'
    stage = 'final report'
    request(f'/issues/comments/{comment}', 'PATCH', json.dumps({'body': body}).encode())
except Exception as error:
    # Never include the API's response, credentials, or untrusted exception text.
    reason = f'HTTP {error.code}' if isinstance(error, urllib.error.HTTPError) else type(error).__name__
    failure = f'Window gallery for `{head}`.\n\nGallery upload failed during {stage} ({reason}). Rerun the gallery job; if it persists, check the relay log and package/attachment write permissions. No captures from this report can be accepted.'
    try: request(f'/issues/comments/{comment}', 'PATCH', json.dumps({'body': failure}).encode())
    except Exception: print('::error::Could not finalize the gallery comment; check tracker connectivity and rerun the gallery job.', file=sys.stderr)
    sys.exit(f'Gallery upload failed during {stage} ({reason}); rerun the gallery job.')
print(f'Gallery posted on pull request {pr}')
PYGALLERY
      # Cleanup failure must not invalidate a completed, downloadable report.
      python3 "$(dirname "${BASH_SOURCE[0]}")/../../scripts/gallery-retention.py" || \
        echo "::warning::Gallery retention failed; rerun the gallery-retention workflow."
    fi
  fi
fi
[ "$conclusion" != success ] || exit 0

# Print the failed steps of each failed job, then fail.
for _ in 1 2 3; do
  if reply=$(gh_get "$api/actions/runs/$run_id/jobs"); then break
  else transport_failure "$api/actions/runs/$run_id/jobs"; sleep 3; fi
done
printf '%s' "$reply" | python3 -c '
import json,sys
try: jobs=json.load(sys.stdin).get("jobs",[])
except ValueError: jobs=[]
for j in jobs:
    if j.get("conclusion") not in ("success","skipped"):
        bad=[s["name"] for s in j.get("steps",[]) if s.get("conclusion")=="failure"]
        print(j["id"], j["name"], "failed at:", ", ".join(bad) or j.get("conclusion"))
' | while read -r job rest; do
  echo "::group::$rest"
  gh_api --fail -L -o "$gl/job-$job.log" "$api/actions/jobs/$job/logs" ||
    { echo "::error::GitHub API transport failed: GET $api/actions/jobs/$job/logs (retries exhausted)"; exit 1; }
  grep -v -E '^\S+Z ##\[(group|endgroup)\]' "$gl/job-$job.log" | tail -n 200 || true
  echo "::endgroup::"
done
echo "::error::GitHub CI $conclusion: https://github.com/$repo/actions/runs/$run_id"
exit 1
