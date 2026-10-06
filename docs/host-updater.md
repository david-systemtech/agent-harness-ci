# The host-side updater

A container never updates itself (ADR 0007). When the agent-harness
environment runs in a container, from the release's `compose.yaml`, the
host-side updater carries out its updates from the Docker host:
`host-updater.sh`, a POSIX shell script published with every release beside
`compose.yaml`.

The environment keeps the plan. Its channel, its pinned version and whether it
updates by itself are its own settings, changed on its Your machines card as
for any machine; it reads the channel and the release manifest, and says when
an update is ready, the moment it would drain were it a native service. The
updater asks it every five minutes and does the rest.

## Inspecting an update

Run `./host-updater.sh --dry-run` from the Docker host, with the same
compose file as the scheduled updater (`AGENT_HARNESS_COMPOSE_FILE` can name
it). The output names the current version and the image the container was
created with, the pending update's state, id and target version, and its
image reference and manifest digest. For a ready update it lists the pull
and digest check, drain, stop, snapshot, `.env` change, recreate, health wait,
watch, rollback on failure, and successful cleanup.

This inspection reads `update status --json` without `--host-updater`, so it
does not record an updater poll. It pulls no image, runs no update verb other
than status, writes no lock, log state, update record or `.env`, runs no
notification command, and changes no update settings or application content.
Like any local CLI status read, it authenticates through the bootstrap
grant; that authentication rotates the grant and records access metadata.
It does not record the host-side updater's last poll or begin an update.
It does not acquire the tick's lock: the report is a view of the plan at
that moment, and a scheduled tick may progress while it is read. It does
not verify registry access or prove that a target will start.

It exits 0 when the plan can be read, including when there is no pending
update ("No pending update", no target or actions), or one is not ready
(its state and no actions). A failed status or image read, an unreadable
status, or a ready target without a usable image reference and SHA-256
digest exits 1 with an explanation. An update-in-flight record reports the
interrupted update and exits 1 without recovering it; a regular tick must
finish it before another update can be planned. Unknown or extra arguments
exit 2. `AGENT_HARNESS_UPDATER=0` keeps its usual meaning: stop before doing
anything, including an inspection.

## What a tick does

Each run is one tick, under one `flock` on `.host-updater.lock` beside the
compose file. A tick that finds the lock held exits at once: the tick holding
it is still under way, and one that updates can take 45 minutes. A tick that
finds the record of an update a tick before it was cut short in finishes that
update first, and ends there ("When a tick is cut short", below).

1. It asks the container for `update status --json --host-updater`, which the
   environment also keeps as the updater's last poll (Set up's Your machines
   entry says when no updater has polled for an hour). Unless the pending
   update is `ready`, the tick ends there.
2. It pulls the target's image by its repository and the release manifest's
   digest, names it by its reference, and checks that the reference is that
   digest. A pull that fails, or an image that is not the manifest's, leaves
   the container running and untouched; the next tick tries again.
3. `update begin` begins the update: the environment refuses new runs and lets
   the running ones finish, up to 30 minutes.
4. `docker compose stop` waits out that drain, up to the compose file's
   31-minute stop grace, and the container stays stopped from here until it is
   recreated.
5. A one-off `docker compose run --rm` of `update snapshot`, on the old image,
   snapshots the database on the stopped volume.
6. It writes the target's reference into the `.env` file beside the compose
   file as `AGENT_HARNESS_IMAGE`, keeping the one it replaces as
   `AGENT_HARNESS_PREVIOUS_IMAGE`, and runs `docker compose up -d`.
7. The health URL must say `ready` at the target's version within 120
   seconds. Then it watches the target for ten minutes: three restarts, or two
   minutes without `ready`, are a crash loop.
8. After a good watch, `update discard` removes the snapshot, and the
   repository's images other than the target and the previous one are removed
   (Docker keeps any a container still uses).

A container that does not start, a failed health wait or a crash loop rolls
back: `docker compose stop`, `update restore` on the previous image with the
stage (`trial` before the target said ready, `crash-loop` in the watch) and
the reason (`start`, `health`, `restarts` or `not-ready`, and `interrupted`
for a tick cut short, below), the previous
reference put back in `.env`, `docker compose up -d`, and the previous version
must say `ready` within 120 seconds. The old version reports the failure
itself as it starts, and that update's snapshot is then discarded. A stop,
snapshot, update record or `.env` write that fails before the target is
written starts the old image's container again as it was
(`docker compose up -d --no-recreate`). After every abandon, including one
that finishes a tick cut short, `update discard --update-id <id>` runs in
that container to remove the abandoned update's snapshot and any staging
folder a snapshot cut short left. It says so and exits 0 when there is none.
A discard failure costs only the room: the old container keeps running and
the outcome stays `abandoned`.

## When a tick is cut short

A reboot, `systemctl stop` of the updater's unit or a kill can cut a tick
short in the middle of an update. So just before `update begin` the updater
writes `.host-updater.update` beside its lock, the record of the update in
flight: the update's id, the version running and the target's, the target's
image and the one it replaces, the `.env` file's
`AGENT_HARNESS_PREVIOUS_IMAGE`, and the step reached. It writes the record
again, through a rename, as each step begins, and removes it at the update's
outcome. A tick that finds the record finishes that update before it asks the
container anything, logs that it does, and ends; the tick after it asks again.

| Cut short | What the next tick does |
| --- | --- |
| At `update begin`, in the stop or in the snapshot | Waits out a stop that was under way, then starts the old image's container again as it was and discards that update's snapshot and staging folder: `abandoned`. An update the environment had begun is settled as failed by the old version as it next starts. |
| After the snapshot, before the target said `ready` | Rolls back as a failed trial, at stage `trial` for the reason `interrupted`, as a failed health wait does: `rolled-back`. |
| In the watch, or after it | Waits up to 120 seconds for the target to say `ready` again, then watches it on to the end the watch had, ten minutes from when it first said `ready`, counting its restarts from the watch's start; an end that passed while no tick ran ends the watch there. Then `updated`, or a crash loop's rollback: `rolled-back`, at stage `crash-loop`, for the reason `not-ready` when the target did not say `ready` again. |
| In a rollback | Runs the restore again with the stage and reason it had, which finishes a restore cut short; once the restore had finished, it only puts the previous image back and starts it: `rolled-back`. |

A record that cannot be written keeps an update from beginning (`not-begun`),
and abandons one that has begun, until its target is written. A record that
cannot be read, empty or naming no step the updater knows, is reported once
(`record-unreadable`), and the updater does nothing more until it is removed.
Read the log's last lines for the step the update reached, and
`docker compose ps` for whether the container runs; finish the update by hand
(the restore is in "When a rollback fails", below), then delete
`.host-updater.update`.

## Installing it

It needs a Linux host with Docker Engine and its Compose plugin
(`docker compose`), `curl`, and `flock` (util-linux). It runs as the user that
runs `docker` there: root, or a member of the `docker` group. Nothing else of
the environment runs on the host.

1. Put `compose.yaml` and `host-updater.sh` of the same release in one folder,
   for example `/opt/agent-harness`, and make the script executable:
   `chmod +x /opt/agent-harness/host-updater.sh`. The updater finds the compose
   file beside itself; `AGENT_HARNESS_COMPOSE_FILE` names another.
2. Start the environment once, as `compose.yaml`'s header says:
   `docker compose up -d` in that folder. The public image is
   `ghcr.io/david-systemtech/agent-harness:<version>`; no registry login is
   required. Obtain the compose file and updater from the same release at
   <https://github.com/david-systemtech/agent-harness/releases>. Put the
   environment's settings, such as the phone address
   `AGENT_HARNESS_WEB_ORIGIN` ([phone guide](phone.md)), in the `.env` file
   beside `compose.yaml`, never in edits to `compose.yaml`: replacing the
   compose file with a newer release's drops such an edit, while `.env` stays
   and the updater rewrites only its `AGENT_HARNESS_IMAGE` and
   `AGENT_HARNESS_PREVIOUS_IMAGE` lines.
3. Run the updater every five minutes, with cron or with a systemd timer.

The environment reads the public GitHub releases anonymously, or with its
configured GitHub forge account for a higher rate limit. The updater consumes
that environment's pending image reference and digest; it does not read a
second release channel. A GitHub 403/429 rate limit appears in `update status`
as a failed check, retried under the environment's existing check cadence.

### With cron

`crontab -e` as that user, and add:

```cron
*/5 * * * * /opt/agent-harness/host-updater.sh >>/opt/agent-harness/host-updater.log 2>&1
```

Variables go on the line, or on lines of their own above it
(`AGENT_HARNESS_NOTIFY_COMMAND=...`).

### With a systemd timer

`/etc/systemd/system/agent-harness-updater.service`:

```ini
[Unit]
Description=The agent-harness host-side updater
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
ExecStart=/opt/agent-harness/host-updater.sh
# Environment=AGENT_HARNESS_NOTIFY_COMMAND=...
```

`/etc/systemd/system/agent-harness-updater.timer`:

```ini
[Unit]
Description=Run the agent-harness host-side updater every five minutes

[Timer]
OnCalendar=*:0/5

[Install]
WantedBy=timers.target
```

Then `systemctl daemon-reload` and `systemctl enable --now
agent-harness-updater.timer`. A `oneshot` service has no start timeout unless
one is set: leave it so, since a tick that updates waits up to 31 minutes for
the stop and ten more for the watch. Its log is
`journalctl -u agent-harness-updater`.

## Its variables

| Variable | What it does |
| --- | --- |
| `AGENT_HARNESS_COMPOSE_FILE` | The environment's compose file. Preset: `compose.yaml` beside the script. |
| `AGENT_HARNESS_HEALTH_URL` | The environment's health URL. Preset: `http://127.0.0.1:7433/health`, since the container shares the host's network. |
| `AGENT_HARNESS_NOTIFY_COMMAND` | A command `sh` runs on each outcome, given `AGENT_HARNESS_OUTCOME` (below) and `AGENT_HARNESS_MESSAGE`, the outcome's log line. Its output goes to standard error; its failure is reported there and the tick goes on. For example `logger -t agent-harness "$AGENT_HARNESS_OUTCOME: $AGENT_HARNESS_MESSAGE"`. |
| `AGENT_HARNESS_UPDATER` | `0` stops the updater before it does anything, for as long as it is set. |

`AGENT_HARNESS_IMAGE` is the `.env` file's, not a variable of the updater: one
in its environment is ignored.

## Its log and its outcomes

It writes one line to standard output per state change, and remembers the last
state in `.host-updater.state` beside the compose file, so a tick that finds
what the last one found writes nothing. What Docker and the environment's
verbs print goes to standard error. It exits 0 when it had nothing to do or
updated, and 1 otherwise.

Each outcome runs the notify command once; a pull that fails again at the next
tick is the same outcome, and is not reported again.

| `AGENT_HARNESS_OUTCOME` | What happened |
| --- | --- |
| `updated` | The target held through its watch. |
| `pull-failed` | The image did not pull, or is not the manifest's digest. The container runs as it was, and the next tick tries again. |
| `not-begun` | The environment refused `update begin`, for example because work started since it said ready, or the updater could not record the update. It runs as it was. |
| `abandoned` | The stop, the snapshot, the update's record or the `.env` write failed after the drain began, or a tick was cut short at its begin, stop or snapshot step; the old image's container was started again as it was, then the update's snapshot and staging folder were discarded (a failed discard costs only the room). |
| `rolled-back` | The target did not start, did not say ready or crash-looped, or a tick was cut short before it said ready, and it was rolled back; the previous version runs. |
| `rollback-failed` | The rollback did not finish, and the environment needs a person (below). |
| `record-unreadable` | The record of an update a tick was cut short in cannot be read; the updater does nothing until a person removes it ("When a tick is cut short"). |

## When a rollback fails

The `rollback-failed` line names the update id, the target's version, the
previous image, the stage and the reason, and what failed; standard error above
it says why. The update's record is removed with that outcome, so the next
ticks leave the container as it is. The restore command below runs on the
previous image, and running it again finishes one cut short:

```sh
AGENT_HARNESS_IMAGE=<previous image> docker compose run --rm environment \
  update restore --update-id <id> --stage <stage> --reason <reason> \
  --to-version <target version> --data-dir /data
```

- **`docker compose stop` failed**: the restore has not run, and the target may
  still be running. Stop it with `docker compose stop`, run the restore, then
  set `AGENT_HARNESS_IMAGE=<previous image>` in `.env` and run
  `docker compose up -d`.
- **`update restore` failed**: the container is left stopped, and must stay so
  until the restore has finished, since nothing may open a database whose
  restore is marked. Run the restore again; once it succeeds, set
  `AGENT_HARNESS_IMAGE=<previous image>` in `.env` and run
  `docker compose up -d`.
- **The container was started while a restore was marked**: `serve` refuses to
  open the database, with this line in `docker compose logs environment`:
  `agent-harness could not start: Startup failed at the database step: The restore of update <id> is unfinished; run agent-harness update restore to finish it before starting the environment.`
  The database, its WAL and shm files, and `restore-marker.json` stay untouched.
  Stop the container, run the restore command above on the previous image to
  finish the restore, then set that image in `.env` and run `docker compose up -d`.
- **`.env` could not be written, `docker compose up -d` failed, or the previous
  version did not say ready**: the restore has finished. Put the previous image
  in `.env` if it is not there, then `docker compose ps` and
  `docker compose logs environment` say what keeps the previous version from
  starting; `docker compose up -d` once that is fixed.

## Stopping updates

To hold a container at its version, pin it or turn auto-update off on its Your
machines card: the environment then makes nothing ready, and the updater does
nothing. To stop the updater itself, set `AGENT_HARNESS_UPDATER=0` in its
crontab line or unit, remove the crontab line, or
`systemctl disable --now agent-harness-updater.timer`.
