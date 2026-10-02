#!/bin/sh
# The host-side updater: carries out the agent-harness environment's update
# plan for its container, from the Docker host that runs it. Cron or a systemd
# timer runs it every five minutes; its documentation, docs/host-updater.md on
# the repository's main branch, shows both and its variables. The environment
# reads public GitHub releases; their public ghcr.io image needs no login.
# This script uses the pending image reference and digest from that source.
#
# A container never updates itself (ADR 0007). The environment keeps the
# plan: channel, pin and auto-update are its settings, so its Your machines
# card governs a container as any machine. Each run is one tick under one
# flock: it asks the container for `update status --json --host-updater`, and
# does nothing more unless the pending update is `ready`. Then it pulls the
# target's image by its repository and digest, names it by its reference and
# checks the digest against the release manifest's, so a failed pull leaves the
# container untouched; runs `update begin`, which drains; stops the container,
# which waits out the drain (the compose file's 31-minute stop grace) and stays
# stopped; snapshots the database with a one-off container of the old image;
# writes the target's reference into the compose project's .env file as
# AGENT_HARNESS_IMAGE, the old one kept as AGENT_HARNESS_PREVIOUS_IMAGE; runs
# `up -d`; waits 120 seconds for the health URL to say ready at the target;
# and watches it for ten minutes, three restarts or two minutes not ready
# being a crash loop. A failed health wait or watch rolls back: stop, `update
# restore` on the previous image, the previous reference put back, `up -d`,
# health checked; the old version's settle reports the failure. After a good
# watch `update discard` removes the snapshot, and the repository's images
# other than the target and the previous go.
#
# From just before `update begin` to its outcome the update in flight is
# recorded beside the lock, with the step it has reached, so a tick cut short
# (a reboot, a kill) is finished by the next one before it asks for anything:
# until the snapshot is taken the old image's container starts again as it
# was; from then until the target said ready it rolls back as a failed trial;
# after that the watch goes on to the end it had.
#
# It logs one line to standard output per state change, remembered across
# ticks, so a tick with nothing new prints nothing, and runs
# AGENT_HARNESS_NOTIFY_COMMAND on each outcome.

set -eu

# Stopped before anything else runs, as the documentation promises.
[ "${AGENT_HARNESS_UPDATER:-1}" != 0 ] || exit 0

NAME=agent-harness
# The compose file's one service, and the data directory its image's serve runs on: every verb in the container names it.
SERVICE=environment
DATA_DIR=/data
DEFAULT_HEALTH_URL=http://127.0.0.1:7433/health
# The launcher's own bounds (launcher-update spec): 120 seconds for the target
# to say ready, then a ten-minute watch in which three restarts, or two
# minutes not ready, are a crash loop. The health URL is probed every 5 seconds.
READY_WAIT_SECONDS=120
WATCH_SECONDS=600
RESTART_LIMIT=3
NOT_READY_SECONDS=120
POLL_SECONDS=5

usage() {
  cat <<USAGE
Usage: host-updater.sh

Carries out the $NAME environment's update plan for its container: one tick,
run every five minutes by cron or a systemd timer.

Environment:
  AGENT_HARNESS_COMPOSE_FILE    the compose file; preset: compose.yaml beside this script
  AGENT_HARNESS_HEALTH_URL      the environment's health URL; preset: $DEFAULT_HEALTH_URL
  AGENT_HARNESS_NOTIFY_COMMAND  a command run by sh on each outcome, given
                                AGENT_HARNESS_OUTCOME and AGENT_HARNESS_MESSAGE
  AGENT_HARNESS_UPDATER         0 stops the updater before it does anything
USAGE
}

case ${1:-} in
  "") ;;
  -h | --help) usage; exit 0 ;;
  *) printf 'Unknown argument %s.\n\n' "$1" >&2; usage >&2; exit 2 ;;
esac

fail() {
  printf 'host-updater.sh: %s\n' "$1" >&2
  exit 1
}

compose_file=${AGENT_HARNESS_COMPOSE_FILE:-$(dirname "$0")/compose.yaml}
[ -f "$compose_file" ] || fail "no compose file at $compose_file: set AGENT_HARNESS_COMPOSE_FILE to the environment's compose.yaml."
compose_dir=$(cd "$(dirname "$compose_file")" && pwd)
compose_file="$compose_dir/$(basename "$compose_file")"
health_url=${AGENT_HARNESS_HEALTH_URL:-$DEFAULT_HEALTH_URL}
# The .env file beside the compose file names the image; one in the updater's own environment would override it.
unset AGENT_HARNESS_IMAGE

for tool in docker curl flock; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed and is not on the PATH."
done

# One tick at a time: a tick that finds the lock held exits at once, since the one holding it is under way.
exec 9>>"$compose_dir/.host-updater.lock"
flock -n 9 || exit 0

env_file="$compose_dir/.env"

compose() {
  docker compose -f "$compose_file" "$@"
}

# Runs compose with the image AGENT_HARNESS_IMAGE names as $1, whatever the .env file says.
compose_on() {
  image=$1
  shift
  AGENT_HARNESS_IMAGE=$image docker compose -f "$compose_file" "$@"
}

# Runs the environment's CLI in its running container.
in_container() {
  compose exec -T "$SERVICE" "$NAME" "$@" --data-dir "$DATA_DIR"
}

state_file="$compose_dir/.host-updater.state"

# Writes one log line when the state named $1 is not the one the last line
# was written for, across ticks, so a tick that finds what the last one found
# writes nothing. Returns 1 when it wrote nothing.
log_state() {
  last=$(cat "$state_file" 2>/dev/null) || last=""
  [ "$1" != "$last" ] || return 1
  printf '%s host-updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2"
  printf '%s\n' "$1" >"$state_file"
}

# Every scalar member of the JSON document on stdin, one per line as
# path=value, the path its object keys from the root joined by dots
# (.pending.image.digest); a string's value is without its quotes, a scalar in
# an array is passed over, and an object in one has [] in its path. Reads the
# pretty and the compact form alike.
json_members() {
  awk '
    function member(value) { if (kind[depth] == "o" && keyed) print prefix[depth] "." key "=" value; keyed = 0 }
    { text = text $0 "\n" }
    END {
      n = length(text)
      for (i = 1; i <= n; i++) {
        c = substr(text, i, 1)
        if (c == "\"") {
          value = ""
          for (i++; i <= n; i++) {
            c = substr(text, i, 1)
            if (c == "\\") { value = value substr(text, i, 2); i++; continue }
            if (c == "\"") break
            value = value c
          }
          if (kind[depth] == "o" && !keyed) { key = value; keyed = 1 } else member(value)
        } else if (c == "{" || c == "[") {
          path = depth == 0 ? "" : (kind[depth] == "o" ? prefix[depth] "." key : prefix[depth] "[]")
          depth++; kind[depth] = c == "{" ? "o" : "a"; prefix[depth] = path; keyed = 0
        } else if (c == "}" || c == "]") {
          depth--; keyed = 0
        } else if (c ~ /[-0-9a-z]/) {
          for (j = i; j <= n && substr(text, j, 1) ~ /[-+.0-9a-zA-Z]/; j++) ;
          member(substr(text, i, j - i)); i = j - 1
        }
      }
    }
  '
}

# The value at the path $1 of the members given as $2, or nothing.
member_of() {
  printf '%s\n' "$2" | awk -v path="$1" 'index($0, path "=") == 1 { print substr($0, length(path) + 2); exit }'
}

# Whether the members given as $2 hold the line $1 (path=value).
has_member() {
  case "
$2
" in
    *"
$1
"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Runs AGENT_HARNESS_NOTIFY_COMMAND, if set, for the outcome $1 with the message $2; its output goes to standard error.
notify() {
  [ -n "${AGENT_HARNESS_NOTIFY_COMMAND:-}" ] || return 0
  AGENT_HARNESS_OUTCOME=$1 AGENT_HARNESS_MESSAGE=$2 sh -c "$AGENT_HARNESS_NOTIFY_COMMAND" >&2 9>&- ||
    printf 'host-updater.sh: AGENT_HARNESS_NOTIFY_COMMAND failed for the outcome %s.\n' "$1" >&2
}

# The record of the update in flight, beside the lock: written before
# `update begin`, written again as each step begins, and removed at the
# update's outcome, so a tick that finds one knows a tick before it was cut
# short (by a reboot, or a kill) and how far it got.
record_file="$compose_dir/.host-updater.update"
# What the record holds, one name=value line each: the step reached, the
# update, the version it runs and its target, the target's image and the one
# it replaces, the .env file's previous image, the watch's end and the
# target's restart count at its start, and a rollback's stage and reason.
RECORD_FIELDS="step update_id to_version running_version reference from_image previous_before watch_end restarts_before stage reason"

# Records the update in flight at the step $1, replacing the record by a rename.
# (Here and in read_record, eval sees only RECORD_FIELDS' names; a value is
# expanded inside the evaluated words, never evaluated itself.)
record() {
  step=$1
  for field in $RECORD_FIELDS; do
    eval "printf '%s=%s\\n' $field \"\${$field:-}\""
  done >"$record_file.new" && mv "$record_file.new" "$record_file"
}

# Reads the record back into the variables its lines name.
read_record() {
  for field in $RECORD_FIELDS; do
    eval "$field=\$(sed -n 's/^$field=//p' \"\$record_file\" | tail -n 1)"
  done
}

# Whether $1 is a count: digits, at least one.
is_count() {
  case $1 in "" | *[!0-9]*) return 1 ;; esac
}

# Whether the record read back names a step and holds what finishing from it needs.
record_readable() {
  [ -n "$update_id" ] && [ -n "$to_version" ] && [ -n "$running_version" ] && [ -n "$reference" ] && [ -n "$from_image" ] || return 1
  case $step in
    begin | stop | snapshot | recreate) ;;
    watch) is_count "$watch_end" && is_count "$restarts_before" ;;
    restore | restart) [ -n "$stage" ] && [ -n "$reason" ] ;;
    *) return 1 ;;
  esac
}

# The update's outcome $1, with the message $2: its record removed, its log
# line, and the notify command when that line is new (a pull that fails again
# at the next tick is not a new outcome).
outcome() {
  rm -f "$record_file"
  if log_state "$1 $update_id" "$2"; then notify "$1" "$2"; fi
}

# Whether the health URL says ready at the version $1.
says_ready() {
  answer=$(curl -fsS --max-time 5 "$health_url" 2>/dev/null) || return 1
  health=$(printf '%s\n' "$answer" | json_members)
  has_member .status=ready "$health" && has_member ".version=$1" "$health"
}

# Waits up to READY_WAIT_SECONDS for the health URL to say ready at the version $1.
wait_ready() {
  deadline=$(($(date +%s) + READY_WAIT_SECONDS))
  until says_ready "$1"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$POLL_SECONDS"
  done
}

# How many times the target's container has restarted since it was created.
restart_count() {
  count=$(docker inspect --format '{{.RestartCount}}' "$container" 2>/dev/null) || count=0
  case $count in "" | *[!0-9]*) count=0 ;; esac
  printf '%s\n' "$count"
}

# Watches the target's container until watch_end, counting its restarts from
# restarts_before. At a crash loop, sets reason and why and returns 1.
watch_target() {
  now=$(date +%s)
  last_ready=$now
  while [ "$now" -lt "$watch_end" ]; do
    sleep "$POLL_SECONDS"
    now=$(date +%s)
    if [ $(($(restart_count) - restarts_before)) -ge "$RESTART_LIMIT" ]; then
      reason=restarts why="$to_version restarted $RESTART_LIMIT times in its watch"
      return 1
    fi
    if says_ready "$to_version"; then
      last_ready=$now
    elif [ $((now - last_ready)) -ge "$NOT_READY_SECONDS" ]; then
      reason=not-ready why="$to_version was not ready at $health_url for $NOT_READY_SECONDS seconds in its watch"
      return 1
    fi
  done
}

# Rewrites the .env file with AGENT_HARNESS_IMAGE=$1 and, unless $2 is empty,
# AGENT_HARNESS_PREVIOUS_IMAGE=$2, keeping its other lines; replaced by a rename.
write_images() {
  {
    if [ -f "$env_file" ]; then
      grep -Ev '^[[:space:]]*(export[[:space:]]+)?AGENT_HARNESS_(PREVIOUS_)?IMAGE[[:space:]]*=' "$env_file" || :
    fi
    printf 'AGENT_HARNESS_IMAGE=%s\n' "$1"
    [ -z "$2" ] || printf 'AGENT_HARNESS_PREVIOUS_IMAGE=%s\n' "$2"
  } >"$env_file.new" && mv "$env_file.new" "$env_file"
}

# The repository of the image reference $1: the reference without its tag.
repository_of() {
  case ${1##*/} in
    *:*) printf '%s\n' "${1%:*}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

# Abandons an update that failed before its target was written: the old
# image's container is started again as it was, not made again from what
# compose would take now.
abandon() {
  compose up -d --no-recreate "$SERVICE" >&2 || :
  # A completed snapshot or staging folder is of no use after an abandon.
  in_container update discard --update-id "$update_id" >&2 || :
  outcome abandoned "Update $update_id to $to_version was not carried out: $1. $running_version was started again as it was."
  exit 1
}

# A rollback that could not finish: the environment needs a person.
rollback_failed() {
  outcome rollback-failed "The rollback of update $update_id from $to_version to $from_image ($stage: $reason) failed: $1. See When a rollback fails in docs/host-updater.md."
  exit 1
}

# Rolls the target back after a failure at the stage $1 for the reason $2,
# $3 saying what failed: stop, restore on the previous image, then the
# previous image started again. A restore that fails leaves the container
# stopped: nothing may open a database whose restore is marked until the
# restore is finished. Each half is recorded as it begins; should neither
# record be written, one cut short still rolls back from the step recorded.
roll_back() {
  stage=$1 reason=$2
  log_state "roll-back $update_id" "$3; rolling back to $from_image." || :
  record restore || :
  compose stop "$SERVICE" >&2 || rollback_failed "docker compose stop failed"
  compose_on "$from_image" run --rm -T "$SERVICE" update restore --update-id "$update_id" --stage "$stage" --reason "$reason" \
    --to-version "$to_version" --data-dir "$DATA_DIR" >&2 ||
    rollback_failed "update restore on $from_image failed, so the container is left stopped"
  record restart || :
  restart_previous
}

# Starts the previous image again once the snapshot is restored: the previous
# reference put back, up -d, and the previous version's health checked.
restart_previous() {
  write_images "$from_image" "$previous_before" || rollback_failed "$env_file could not be written"
  compose up -d "$SERVICE" >&2 || rollback_failed "docker compose up -d on $from_image failed"
  wait_ready "$running_version" ||
    rollback_failed "the snapshot is restored, but $running_version did not say ready at $health_url within $READY_WAIT_SECONDS seconds"
  # The previous version has settled the failure as it said ready, so its snapshot can go.
  in_container update discard --update-id "$update_id" >&2 || :
  outcome rolled-back "Rolled update $update_id back from $to_version to $running_version ($stage: $reason): the snapshot is restored and $from_image runs again."
  exit 1
}

# Ends an update whose target held through its watch: the snapshot is
# discarded, and every image of the repository but the target and the one it
# replaced is removed, which docker refuses for one a container still uses.
finish_update() {
  discarded="the snapshot is discarded"
  in_container update discard --update-id "$update_id" >&2 || discarded="update discard failed, so the snapshot is kept"
  for image in $(docker image ls --format '{{.Repository}}:{{.Tag}}' "$(repository_of "$reference")" 2>/dev/null); do
    case $image in
      *:"<none>" | "$reference" | "$from_image") ;;
      *) docker image rm "$image" >/dev/null 2>&1 || : ;;
    esac
  done
  outcome updated "Updated from $running_version to $to_version (update $update_id): $discarded, and images older than $from_image are removed."
  exit 0
}

# Finishes the update a tick was cut short in, as its record says, and ends
# the tick: until the snapshot was taken, the old image's container starts
# again as it was, a stop under way waited out first; after the snapshot and
# before the target said ready, it rolls back as a failed trial; a rollback
# cut short is finished, from its restore or after it; and after the target
# said ready, it must say ready again, and its watch goes on to the end it
# had, ending there when that has passed.
finish_cut_short() {
  read_record
  if ! record_readable; then
    # How far the update got is not known, so nothing is done until a person has looked.
    message="The record of an update in flight, $record_file, cannot be read, so the host-side updater does nothing until it is removed. See When a tick is cut short in docs/host-updater.md."
    if log_state record-unreadable "$message"; then notify record-unreadable "$message"; fi
    exit 1
  fi
  log_state "resume $step $update_id" "Update $update_id to $to_version was cut short at its $step step; finishing it." || :
  case $step in
    begin | stop | snapshot)
      [ "$step" != stop ] || compose stop "$SERVICE" >&2 || :
      abandon "its tick was cut short before the target was started" ;;
    recreate) roll_back trial interrupted "The tick was cut short before $to_version said ready" ;;
    restore) roll_back "$stage" "$reason" "The rollback ($stage: $reason) was cut short" ;;
    restart) restart_previous ;;
    watch)
      container=$(compose ps -q "$SERVICE" 2>/dev/null) || container=""
      restarts_now=$(restart_count)
      # A count below the one the watch began with is another container's, which counts from now.
      [ "$restarts_now" -ge "$restarts_before" ] || restarts_before=$restarts_now
      # The target says ready first, as before the first watch: a watch whose end passed unwatched ends at once.
      wait_ready "$to_version" ||
        roll_back crash-loop not-ready "$to_version did not say ready at $health_url within $READY_WAIT_SECONDS seconds as its watch resumed"
      watch_target || roll_back crash-loop "$reason" "$why"
      finish_update ;;
  esac
}

[ ! -f "$record_file" ] || finish_cut_short

if ! status=$(in_container update status --json --host-updater); then
  log_state unreachable "The environment's container did not answer update status: is it running, on an image with the host-side updater's verbs? ($compose_file)" || :
  exit 1
fi
members=$(printf '%s\n' "$status" | json_members)
running_version=$(member_of .version "$members")
pending_state=$(member_of .pending.state "$members")
update_id=$(member_of .pending.updateId "$members")
to_version=$(member_of .pending.toVersion "$members")

case $pending_state in
  ready) ;;
  current)
    log_state current "Nothing to update: the environment runs $running_version." || :
    exit 0 ;;
  "")
    log_state unreadable "The environment's update status names no pending update the host-side updater can read." || :
    exit 1 ;;
  *)
    log_state "$pending_state $update_id" "The update to $to_version is $pending_state, not ready for the host-side updater." || :
    exit 0 ;;
esac

reference=$(member_of .pending.image.reference "$members")
digest=$(member_of .pending.image.digest "$members")
# The image the container runs now, as compose resolves it: the .env file's, or the compose file's default.
from_image=$(compose config --images "$SERVICE" | head -n 1) || from_image=""
[ -n "$from_image" ] || fail "compose names no image for $SERVICE in $compose_file."
previous_before=$(sed -n 's/^AGENT_HARNESS_PREVIOUS_IMAGE=//p' "$env_file" 2>/dev/null | tail -n 1) || previous_before=""

# Pulls the target by its repository and the manifest's digest, names it by
# its reference, and checks that the reference is the manifest's digest.
# Sets why and returns 1 when it cannot.
pull_target() {
  case $reference in
    "") why="the ready update names no image to pull"; return 1 ;;
    *[!A-Za-z0-9._/:-]*) why="the ready update's image reference is not one to pull ($reference)"; return 1 ;;
  esac
  case $digest in
    sha256:*) ;;
    *) why="the ready update names no image digest ($digest)"; return 1 ;;
  esac
  hex=${digest#sha256:}
  case $hex in
    *[!0-9a-f]*) why="the ready update names no image digest ($digest)"; return 1 ;;
  esac
  [ ${#hex} = 64 ] || { why="the ready update names no image digest ($digest)"; return 1; }
  repository=$(repository_of "$reference")
  docker pull "$repository@$digest" >&2 || { why="docker pull $repository@$digest failed"; return 1; }
  docker tag "$repository@$digest" "$reference" >&2 || { why="docker tag $repository@$digest $reference failed"; return 1; }
  pulled=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$reference") ||
    { why="docker image inspect $reference failed"; return 1; }
  has_member "$repository@$digest" "$pulled" || { why="$reference is not the release manifest's $digest"; return 1; }
}

if ! pull_target; then
  outcome pull-failed "Update $update_id to $to_version is ready, but its image did not pull: $why. The container runs as it was."
  exit 1
fi

log_state "begin $update_id" "Pulled $reference and checked its digest; beginning update $update_id from $running_version to $to_version." || :
if ! record begin; then
  outcome not-begun "Update $update_id to $to_version was not begun, since $record_file could not be written; the container runs as it was."
  exit 1
fi
if ! in_container update begin --update-id "$update_id" >&2; then
  outcome not-begun "The environment refused to begin update $update_id to $to_version, and runs as it was."
  exit 1
fi

log_state "stop $update_id" "The environment is draining; stopping its container, which waits out the drain." || :
record stop || abandon "$record_file could not be written"
compose stop "$SERVICE" >&2 || abandon "docker compose stop failed"

log_state "snapshot $update_id" "Stopped; snapshotting the database on $from_image." || :
record snapshot || abandon "$record_file could not be written"
compose_on "$from_image" run --rm -T "$SERVICE" update snapshot --update-id "$update_id" --data-dir "$DATA_DIR" >&2 ||
  abandon "update snapshot failed"

log_state "recreate $update_id" "Recreating the container on $reference; waiting up to $READY_WAIT_SECONDS seconds for it to say ready." || :
record recreate || abandon "$record_file could not be written"
write_images "$reference" "$from_image" || abandon "$env_file could not be written"
compose up -d "$SERVICE" >&2 || roll_back trial start "The container did not start on $reference"
wait_ready "$to_version" ||
  roll_back trial health "$to_version did not say ready at $health_url within $READY_WAIT_SECONDS seconds"

log_state "watch $update_id" "$to_version says ready; watching it for $((WATCH_SECONDS / 60)) minutes." || :
container=$(compose ps -q "$SERVICE" 2>/dev/null) || container=""
restarts_before=$(restart_count)
watch_end=$(($(date +%s) + WATCH_SECONDS))
# Unrecorded, a tick cut short in the watch rolls the target back as one cut short before it said ready would.
record watch || :
watch_target || roll_back crash-loop "$reason" "$why"
finish_update
