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
case "$event" in ci | catalogue) ;; *) echo "::error::unknown CI event"; exit 1 ;; esac

gh_api() {
  curl -sS --retry 3 --retry-all-errors -H "Authorization: Bearer $GH_CI_TOKEN" \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" "$@"
}

# The same gitleaks pin as david/ci scripts/secret-scan.sh; only HEAD's history.
case "$(uname -m)" in
  x86_64) gl_arch=x64 gl_sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  aarch64 | arm64) gl_arch=arm64 gl_sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  *) echo "::error::No gitleaks build pinned for $(uname -m)"; exit 1 ;;
esac
gl=$(mktemp -d)
trap 'rm -rf "$gl"' EXIT
curl -sSfL --retry 3 -o "$gl/g.tgz" "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${gl_arch}.tar.gz"
echo "$gl_sum  $gl/g.tgz" | sha256sum -c - >/dev/null
tar -xzf "$gl/g.tgz" -C "$gl" gitleaks
"$gl/gitleaks" git --no-banner --redact --exit-code 1 --log-opts="HEAD" . ||
  { echo "::error::gitleaks found a secret; nothing was pushed to GitHub"; exit 1; }

echo "Pushing $sha to $repo as ci/$id"
auth=(-c credential.helper= -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_CI_TOKEN" | base64 -w0)")
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
code=$(gh_api -o /dev/null -w '%{http_code}' -X POST "$api/dispatches" -d "$payload")
[ "$code" = 204 ] || { echo "::error::repository_dispatch answered HTTP $code"; exit 1; }

title="$event $sha $id"
run_id=
for _ in $(seq 1 30); do
  sleep 5
  run_id=$(gh_api "$api/actions/runs?event=repository_dispatch&per_page=30" |
    python3 -c 'import json,sys; t=sys.argv[1]; print(next((str(r["id"]) for r in json.load(sys.stdin).get("workflow_runs",[]) if r.get("display_title")==t),""))' "$title")
  [ -n "$run_id" ] && break
done
[ -n "$run_id" ] || { echo "::error::no GitHub run appeared for $title within 150 s"; exit 1; }
echo "GitHub run: https://github.com/$repo/actions/runs/$run_id"

while :; do
  read -r status conclusion < <(gh_api "$api/actions/runs/$run_id" |
    python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("status") or "unknown", r.get("conclusion") or "-")')
  [ "$status" = completed ] && break
  sleep 15
done
echo "GitHub run finished: $conclusion"
[ "$conclusion" = success ] && exit 0

# Print the failed steps of each failed job, then fail.
gh_api "$api/actions/runs/$run_id/jobs" | python3 -c '
import json,sys
for j in json.load(sys.stdin).get("jobs",[]):
    if j.get("conclusion") not in ("success","skipped"):
        bad=[s["name"] for s in j.get("steps",[]) if s.get("conclusion")=="failure"]
        print(j["id"], j["name"], "failed at:", ", ".join(bad) or j.get("conclusion"))
' | while read -r job rest; do
  echo "::group::$rest"
  gh_api -L "$api/actions/jobs/$job/logs" | grep -v -E '^\S+Z ##\[(group|endgroup)\]' | tail -n 200 || true
  echo "::endgroup::"
done
echo "::error::GitHub CI $conclusion: https://github.com/$repo/actions/runs/$run_id"
exit 1
