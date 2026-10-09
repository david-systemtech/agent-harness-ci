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
#    The run's last job deletes ci/<id>. A run GitHub failed with no failed job
#    passes only when every job the verdict needs passed (#1816).
#
# The `smoke` event (.forgejo/workflows/smoke.yml) first checks that the hosted
# smoke and release workflows installed on `workflows` are this commit's.
#
# Needs GH_CI_TOKEN: a fine-grained token for agent-harness-ci, with Contents
# read/write (the push, and repository_dispatch) and Actions read (the run). GROUP is the pull request number or,
# on main, the commit, so a newer push to a pull request cancels the older run on GitHub as it does here and
# every main run finishes.
set -euo pipefail

: "${GH_CI_TOKEN:?GH_CI_TOKEN is not set}" "${GROUP:?}" "${FORGEJO_RUN:=}"
repo=${GH_CI_REPO:-david-systemtech/agent-harness-ci}
api=https://api.github.com/repos/$repo
group=$(printf '%s' "$GROUP" | tr -c 'A-Za-z0-9._-' '-')
# A separate network job shares the transport, not the unit suite.
event=${GH_CI_EVENT:-ci}
case "$event" in ci | catalogue | gallery | smoke) ;; *) echo "::error::unknown CI event"; exit 1 ;; esac
sha=$(git rev-parse HEAD)
if [ "$event" = gallery ]; then
  # This script and its sibling publisher stay checked out from the trusted base.
  # Fetching objects for the public capture runner never checks out or runs PR code here.
  [ "${GITHUB_EVENT_NAME:-}" = pull_request_target ] ||
    { echo "::error::gallery publication requires a trusted pull_request_target workflow"; exit 1; }
  [[ "${GH_CI_SHA:-}" =~ ^[0-9a-f]{40}$ ]] ||
    { echo "::error::invalid gallery target sha"; exit 1; }
  sha=$GH_CI_SHA
  git fetch --quiet --no-tags origin "$sha"
  git cat-file -e "$sha^{commit}"
fi
id="$(date -u +%Y%m%d%H%M%S)-${sha:0:12}-$RANDOM"

# Each attempt has 120 s, enough for a 16 KB run reply at the site's measured 1.2 KB/s.
# Retries start within 180 s; the last attempt can take another 120 s.
gh_api() {
  curl -sS --connect-timeout 15 --max-time 120 --retry 5 --retry-delay 3 --retry-max-time 180 --retry-all-errors -H @<(printf 'Authorization: Bearer %s\n' "$GH_CI_TOKEN") \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}
# Gallery ZIPs can take minutes on a slow link. Give each attempt ten minutes,
# with retries starting within ten minutes (at most twenty including the last
# attempt). The gallery workflow's 55-minute deadline still bounds the entire
# shard set, capture and publication included. Keep the 64 MiB transfer cap.
gh_artifact() {
  curl -sS --connect-timeout 15 --max-time 600 --retry 2 --retry-delay 3 --retry-max-time 600 --retry-all-errors --fail -L --max-filesize 67108864 -H @<(printf 'Authorization: Bearer %s\n' "$GH_CI_TOKEN") \
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

# Three failed polls cost at most 15 minutes of API transport, within the 55-minute
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
"$gl/gitleaks" git --no-banner --redact --exit-code 1 --log-opts="$sha" . ||
  { echo "::error::gitleaks found a secret; nothing was pushed to GitHub"; exit 1; }

auth=(-c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$GH_CI_TOKEN"; }; f')
export GH_CI_TOKEN GIT_TERMINAL_PROMPT=0
if [ "$event" = smoke ]; then
  # The hosted smoke calls the release workflow, and both run as installed by hand on the relay
  # repository's `workflows` branch (#1769). A copy that is not this commit's would smoke another
  # release than the one this commit publishes, so nothing runs until both are installed byte for byte.
  git "${auth[@]}" fetch --quiet --no-tags "https://github.com/$repo.git" refs/heads/workflows ||
    { echo "::error::could not read $repo's workflows branch"; exit 1; }
  installed=$(git rev-parse FETCH_HEAD)
  for pair in .forgejo/github-workflows/smoke.yml:.github/workflows/smoke.yml public/.github-workflows/release.yml:.github/workflows/release.yml; do
    source=${pair%%:*} target=${pair#*:}
    if ! want=$(git rev-parse -q --verify "$sha:$source") || [ "$(git rev-parse -q --verify "$installed:$target")" != "$want" ]; then
      echo "::error::$repo's $target on its workflows branch is not this commit's $source; install it there byte for byte"
      exit 1
    fi
  done
fi
echo "Pushing $sha to $repo as ci/$id"
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

# A plan plus 100 captures and cleanup can span two job/artifact pages.
gh_collection() {
  local path=$1 key=$2 page=1 reply count total out counts
  out=$(mktemp -p "$gl")
  while :; do
    if ! reply=$(gh_get "$api/actions/runs/$run_id/$path?per_page=100&page=$page"); then rm -f "$out"; return 1; fi
    if ! counts=$(printf '%s' "$reply" | python3 -c '
import json,sys
r=json.load(sys.stdin); rows=r.get(sys.argv[1]); total=r.get("total_count",len(rows) if isinstance(rows,list) else None)
if not isinstance(rows,list) or len(rows)>100 or type(total) is not int or not len(rows)<=total<=1000: sys.exit(1)
with open(sys.argv[2],"a") as out: out.write(json.dumps(r)+"\n")
print(len(rows),total)' "$key" "$out"); then rm -f "$out"; return 1; fi
    read -r count total <<< "$counts"
    [ "$((page * 100))" -ge "$total" ] && break
    [ "$count" -eq 100 ] || { rm -f "$out"; return 1; }
    page=$((page + 1))
  done
  if ! python3 -c 'import json,sys; rows=[json.loads(line)[sys.argv[2]] for line in open(sys.argv[1])]; print(json.dumps({sys.argv[2]:[item for page in rows for item in page]}))' "$out" "$key"; then rm -f "$out"; return 1; fi
  rm -f "$out"
}
gallery_plan=

while :; do
  if reply=$(gh_get "$api/actions/runs/$run_id"); then :
  else transport_failure "$api/actions/runs/$run_id"; sleep 15; continue; fi
  read -r status conclusion < <(printf '%s' "$reply" | python3 -c '
import json,sys
try: r=json.load(sys.stdin)
except ValueError: r={}
print(r.get("status") or "unknown", r.get("conclusion") or "-")')
  if [ "$status" = completed ] && [[ "$conclusion" != success && "$conclusion" != failure ]]; then break; fi
  if [ "$event" = gallery ]; then
    if ! jobs=$(gh_collection jobs jobs); then transport_failure "$api/actions/runs/$run_id/jobs"; sleep 15; continue; fi
    printf '%s' "$jobs" > "$gl/gallery-jobs.json"
    if [ -z "$gallery_plan" ] && printf '%s' "$jobs" | python3 -c 'import json,sys; sys.exit(not any(j.get("name")=="plan" and j.get("status")=="completed" and j.get("conclusion")=="success" for j in json.load(sys.stdin)["jobs"]))'; then
      if ! listing=$(gh_collection artifacts artifacts); then transport_failure "$api/actions/runs/$run_id/artifacts"; sleep 15; continue; fi
      plan_id=$(printf '%s' "$listing" | python3 -c '
import json,sys
plans=[a for a in json.load(sys.stdin)["artifacts"] if a["name"]=="gallery-plan"]
if len(plans)>1 or any(a.get("expired") or a["size_in_bytes"]>65536 for a in plans): sys.exit("invalid gallery plan artifact")
print(plans[0]["id"] if plans else "")')
      if [ -n "$plan_id" ]; then
        gh_artifact -o "$gl/plan.zip" "$api/actions/artifacts/$plan_id/zip"
        python3 "$(dirname "${BASH_SOURCE[0]}")/gallery-ready.py" plan "$gl/plan.zip" > "$gl/gallery-plan.json"
        gallery_plan="$gl/gallery-plan.json"
      fi
    fi
    if [ -n "$gallery_plan" ]; then
      ready=$(python3 "$(dirname "${BASH_SOURCE[0]}")/gallery-ready.py" jobs "$gallery_plan" "$gl/gallery-jobs.json")
      if [ "$ready" != pending ]; then
        conclusion=$ready
        echo "Gallery plan and every expected capture finished: $conclusion (cleanup is not required)."
        break
      fi
      [ "$status" != completed ] || { echo "::error::hosted gallery finished with missing or unfinished planned captures"; exit 1; }
    fi
  fi
  transport_failures=0
  [ "$status" = completed ] && break
  sleep 15
done
reply_run=$reply
echo "GitHub run finished: $conclusion"
# Failed comparisons still publish the captures, baseline and difference for review.
if [ "$event" = gallery ] && [[ "$conclusion" == success || "$conclusion" == failure ]]; then
  reply=$(gh_collection artifacts artifacts)
  artifacts=$(printf '%s' "$reply" | python3 -c '
import json,re,sys
items=[a for a in json.load(sys.stdin).get("artifacts",[]) if a["name"].startswith("window-gallery") and not a.get("expired")]
plan=json.load(open(sys.argv[1])) if sys.argv[1] else None
if plan and {a["name"] for a in items}!={r["artifact"] for r in plan}: sys.exit("incomplete planned gallery artifact set")
if not items: sys.exit(0)
names=[a["name"] for a in items]
if len(items)>100 or len(set(names))!=len(items) or ("window-gallery" in names and len(items)!=1) or any(a["size_in_bytes"]>64*1024*1024 for a in items): sys.exit("oversized or duplicate gallery artifact")
for a in items:
    match=re.fullmatch(r"window-gallery-shard-([1-9][0-9]*)",a["name"])
    named=re.fullmatch(r"window-gallery-(desktop|phone)-[0-9]{3}",a["name"])
    if a["name"]!="window-gallery" and not named and (match is None or int(match[1])>16): sys.exit("invalid gallery artifact name")
    print(int(a["id"]),a["name"].removeprefix("window-"))' "$gallery_plan")
  if [ -z "$artifacts" ]; then
    echo "No gallery artifact was uploaded; reading the failed job logs."
    [ "$conclusion" != success ] || { echo "::error::successful gallery run has no artifact"; exit 1; }
  else
    archives=()
    while read -r artifact name; do
      archive="$gl/$name.zip"
      gh_artifact -o "$archive" "$api/actions/artifacts/$artifact/zip"
      archives+=("$archive")
    done <<< "$artifacts"
    gallery_format=$(python3 - "${archives[@]}" <<'PYFORMAT'
import pathlib,sys,zipfile
formats=[]
for path in sys.argv[1:]:
    archive=pathlib.Path(path)
    if archive.stat().st_size > 64*1024*1024: sys.exit('gallery zip is too large')
    with zipfile.ZipFile(archive) as z: formats.append('report' if 'report.json' in z.namelist() else 'captures')
if len(formats)>1 and any(f!='report' for f in formats): sys.exit('mixed gallery report formats')
print(formats[0])
PYFORMAT
    )
    if [ "$gallery_format" = captures ]; then
      # A workflow rollout can finish an earlier capture-only artifact.
      bash "$(dirname "${BASH_SOURCE[0]}")/gallery-comment.sh" "$gl/gallery.zip" "$sha"
    else
      run_attempt=$(printf '%s' "$reply_run" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("run_attempt",1))')
      GALLERY_PLAN="$gallery_plan" GALLERY_PUBLICATION_RUN="run-$run_id-$run_attempt" python3 "$(dirname "${BASH_SOURCE[0]}")/../../scripts/gallery-publish.py" "$sha" "${archives[@]}"
      # Repository-wide retention has its own daily/manual workflow. Do not let
      # its inventory scan consume the publication job's remaining deadline.
    fi
  fi
fi
[ "$conclusion" != success ] || exit 0

# Print the failed steps of each failed job, then fail.
for _ in 1 2 3; do
  if reply=$(gh_get "$api/actions/runs/$run_id/jobs"); then break
  else transport_failure "$api/actions/runs/$run_id/jobs"; sleep 3; fi
done
printf '%s' "$reply" > "$gl/jobs.json"
# GitHub sometimes ends a run as failed with none of its jobs failed: on 2026-10-07 two
# ci runs' jobs all passed, the cleanup job never appeared and the run page's one
# annotation was GitHub's "Internal server error" (#1816). A ci run still passes then
# when every job the verdict needs passed: each job of the hosted ci workflow at the
# run's commit but cleanup, which only deletes ci/<id> (the hosted sweep removes it).
if [ "$conclusion" = failure ] && python3 -c '
import json,sys
sys.exit(any(j.get("conclusion") not in ("success","skipped") for j in json.load(open(sys.argv[1])).get("jobs",[])))' "$gl/jobs.json"; then
  missing="(the jobs its workflow needs could not be read)"
  read -r head_sha path < <(printf '%s' "$reply_run" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("head_sha") or "-", r.get("path") or "-")')
  if [ "$event" = ci ] && workflow=$(gh_get "$api/contents/$path?ref=$head_sha"); then
    printf '%s' "$workflow" > "$gl/workflow.json"
    missing=$(python3 - "$gl/workflow.json" "$gl/jobs.json" <<'PYVERDICT'
import base64,json,re,sys
def needed(text):
    # The jobs section ends at the next top-level key. Each line there at two spaces must be a plain
    # job key, `id:` with at most a comment: a key in any other form would fold its job into the one before.
    section=re.split(r"^(?=[^\s#])", text.partition("\njobs:\n")[2], maxsplit=1, flags=re.M)[0]
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+:[ \t]*(?:#.*)?", line[2:]) for line in section.splitlines() if re.match(r"  [^\s#]", line)): return []
    jobs=re.split(r"^  ([A-Za-z0-9_-]+):[ \t]*(?:#.*)?$", section, flags=re.M)
    names=[]
    for job,body in zip(jobs[1::2],jobs[2::2]):
        if job=="cleanup": continue
        # A job named otherwise, or a matrix other than one shard list, is not read: nothing passes on a guess.
        shards=re.search(r"^ {6}matrix:\n {8}shard: \[([0-9, ]+)\]\n(?! {8}\S)", body+"\n", re.M)
        if re.search(r"^ {4}name:", body, re.M) or ("matrix:" in body and not shards): return []
        names+=[f"{job} ({s.strip()})" for s in shards[1].split(",")] if shards else [job]
    return names
want=needed(base64.b64decode(json.load(open(sys.argv[1])).get("content","")).decode())
passed={j.get("name") for j in json.load(open(sys.argv[2])).get("jobs",[]) if j.get("conclusion")=="success"}
print(", ".join(n for n in want if n not in passed) if want else "(the jobs its workflow needs could not be read)")
PYVERDICT
    ) || missing="(the jobs its workflow needs could not be read)"
  fi
  if [ "$event" = ci ] && [ -z "$missing" ]; then
    echo "::warning::GitHub ended the run as failed although none of its jobs failed; every job the verdict needs passed, so it passes (its cleanup never ran, and the hosted sweep deletes ci/$id): https://github.com/$repo/actions/runs/$run_id"
    exit 0
  fi
  verdict=
  [ "$event" != ci ] || verdict=" Jobs the verdict needs that did not pass: $missing."
  echo "::error::GitHub ended the run as failed although none of its jobs failed.$verdict Its run page names the cause; a re-run clears an error of GitHub's, not one in the workflow file: https://github.com/$repo/actions/runs/$run_id"
  exit 1
fi
python3 -c '
import json,sys
try: jobs=json.load(sys.stdin).get("jobs",[])
except ValueError: jobs=[]
for j in jobs:
    if j.get("conclusion") not in ("success","skipped"):
        bad=[s["name"] for s in j.get("steps",[]) if s.get("conclusion")=="failure"]
        print(j["id"], j["name"], "failed at:", ", ".join(bad) or j.get("conclusion"))
' < "$gl/jobs.json" | while read -r job rest; do
  echo "::group::$rest"
  gh_api --fail -L -o "$gl/job-$job.log" "$api/actions/jobs/$job/logs" ||
    { echo "::error::GitHub API transport failed: GET $api/actions/jobs/$job/logs (retries exhausted)"; exit 1; }
  grep -v -E '^\S+Z ##\[(group|endgroup)\]' "$gl/job-$job.log" | tail -n 200 || true
  echo "::endgroup::"
done
echo "::error::GitHub CI $conclusion: https://github.com/$repo/actions/runs/$run_id"
exit 1
