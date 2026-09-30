/**
 * The host-side updater, run by `sh` against a fake `docker`, `curl` and
 * `flock` on PATH and a held clock (a fake `date`, and a `sleep` that moves
 * it on): nothing here touches Docker, the network or the wall clock. The
 * fake `docker` plays one compose project: `update status` answers the status
 * document the test gives while the container runs, `run` and `up -d` record
 * the image compose would take (the shell's AGENT_HARNESS_IMAGE over the
 * `.env` file's over the compose file's default), and the target's image
 * restarts at the seconds after its `up -d` the test names. The fake `curl`
 * answers the health URL for the image that runs, ready at its tag's version
 * unless the test says otherwise for the target.
 */
import { execFile, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = join(import.meta.dirname, "..", "scripts", "host-updater.sh");
const run = promisify(execFile);

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.reverse()) cleanup();
  cleanups = [];
});

const REPOSITORY = "git.systemtech.dev:5526/david/agent-harness";
const OLDER = `${REPOSITORY}:0.4.0`;
const OLD = `${REPOSITORY}:0.5.0`;
const NEW = `${REPOSITORY}:0.6.0`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const UPDATE_ID = "6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const HEALTH = "http://127.0.0.1:7433/health";

/** The calls the updater makes, as the fakes log them (compose's `-f <file>` left out). */
const STATUS = "docker compose exec -T environment agent-harness update status --json --host-updater --data-dir /data";
const IMAGES = "docker compose config --images environment";
const PULL = `docker pull ${REPOSITORY}@${DIGEST}`;
const TAG = `docker tag ${REPOSITORY}@${DIGEST} ${NEW}`;
const CHECK = `docker image inspect --format {{range .RepoDigests}}{{println .}}{{end}} ${NEW}`;
const BEGIN = `docker compose exec -T environment agent-harness update begin --update-id ${UPDATE_ID} --data-dir /data`;
const STOP = "docker compose stop environment";
const snapshotOn = (image: string) => `docker compose run --rm -T environment update snapshot --update-id ${UPDATE_ID} --data-dir /data [${image}]`;
const upOn = (image: string) => `docker compose up -d environment [${image}]`;
const PROBE = `curl ${HEALTH}`;
const CONTAINER = "docker compose ps -q environment";
const RESTARTS = "docker inspect --format {{.RestartCount}} container-for-tests";
const restoreOn = (image: string, stage: string, reason: string) =>
  `docker compose run --rm -T environment update restore --update-id ${UPDATE_ID} --stage ${stage} --reason ${reason} --to-version 0.6.0 --data-dir /data [${image}]`;
const DISCARD = `docker compose exec -T environment agent-harness update discard --update-id ${UPDATE_ID} --data-dir /data`;
const LIST_IMAGES = `docker image ls --format {{.Repository}}:{{.Tag}} ${REPOSITORY}`;

const write = (path: string, text: string, mode = 0o644) => {
  writeFileSync(path, text);
  chmodSync(path, mode);
};

/** The held clock: `date +%s` reads it, `sleep` moves it on by its seconds at once, and any other `date` prints a fixed time. */
const FAKE_DATE = `#!/bin/sh
case "$*" in
  +%s) cat "$FAKE_STATE/clock" ;;
  *) echo 2026-09-30T08:00:00Z ;;
esac
`;
const FAKE_SLEEP = `#!/bin/sh
echo $(( $(cat "$FAKE_STATE/clock") + $1 )) > "$FAKE_STATE/clock"
`;

/** A fake flock: logs its call, and says the lock is held when the test made it so. */
const FAKE_FLOCK = `#!/bin/sh
printf 'flock %s\\n' "$*" >> "$FAKE_LOG"
[ ! -f "$FAKE_STATE/lock-held" ]
`;

/** Seconds since the running container's \`up -d\`. */
const SINCE_UP = `since_up() { echo $(( $(cat "$FAKE_STATE/clock") - $(cat "$FAKE_STATE/up-at" 2>/dev/null || cat "$FAKE_STATE/clock") )); }`;

/**
 * A fake curl for the health URL: refuses a connection while no container
 * runs; otherwise says ready at the running image's tag, except that the
 * target's image says starting for its first FAKE_TARGET_READY_AFTER seconds,
 * answers nothing from FAKE_TARGET_DOWN_FROM seconds on, and names
 * FAKE_TARGET_SAYS_VERSION instead of its tag when that is set.
 */
const FAKE_CURL = `#!/bin/sh
url=""
while [ $# -gt 0 ]; do
  case $1 in
    --max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf 'curl %s\\n' "$url" >> "$FAKE_LOG"
${SINCE_UP}
[ "$url" = "$FAKE_HEALTH_URL" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
[ -f "$FAKE_STATE/running" ] || { echo "curl: (7) Failed to connect" >&2; exit 7; }
image=$(cat "$FAKE_STATE/running")
version=\${image##*:}
status=ready
if [ "$image" = "$FAKE_TARGET" ]; then
  version=\${FAKE_TARGET_SAYS_VERSION:-$version}
  [ "$(since_up)" -ge "\${FAKE_TARGET_READY_AFTER:-0}" ] || status=starting
  if [ -n "\${FAKE_TARGET_DOWN_FROM:-}" ] && [ "$(since_up)" -ge "$FAKE_TARGET_DOWN_FROM" ]; then
    echo "curl: (7) Failed to connect" >&2; exit 7
  fi
fi
printf '{"status":"%s","version":"%s"}' "$status" "$version"
`;

/**
 * A fake docker, one compose project with one service, environment. It logs
 * each call without compose's \`-f <file>\`, and \`run\` and \`up\` with the
 * image compose would take in brackets. FAKE_FAIL names the calls that fail
 * (pull, begin, stop, snapshot, restore, up, up-again), FAKE_PULLED_DIGEST the
 * digest the pulled image turns out to have, and FAKE_TARGET_RESTARTS the
 * seconds after its \`up -d\` at which the target's container restarts.
 */
const FAKE_DOCKER = `#!/bin/sh
if [ "$1" = compose ]; then
  shift
  [ "$1" = -f ] && { [ "$2" = "$FAKE_COMPOSE_FILE" ] || { echo "docker: another compose file, $2" >&2; exit 98; }; shift 2; }
  set -- compose "$@"
fi
${SINCE_UP}
fails() { case " \${FAKE_FAIL:-} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
image_now() {
  if [ -n "\${AGENT_HARNESS_IMAGE:-}" ]; then echo "$AGENT_HARNESS_IMAGE"; return; fi
  from_file=$(sed -n 's/^AGENT_HARNESS_IMAGE=//p' "$FAKE_COMPOSE_DIR/.env" 2>/dev/null | tail -n 1)
  echo "\${from_file:-$FAKE_DEFAULT_IMAGE}"
}
case "$*" in
  "compose run "* | "compose up "*) printf 'docker %s [%s]\\n' "$*" "$(image_now)" >> "$FAKE_LOG" ;;
  *) printf 'docker %s\\n' "$*" >> "$FAKE_LOG" ;;
esac
running() { [ -f "$FAKE_STATE/running" ] || { echo 'service "environment" is not running' >&2; exit 1; }; }
case "$*" in
  "compose exec -T environment agent-harness update status "*)
    running
    # A tick the test holds here waits until the test writes to the FIFO.
    [ -z "\${FAKE_HOLD:-}" ] || cat "$FAKE_STATE/hold" >/dev/null
    cat "$FAKE_STATE/status.json" ;;
  "compose exec -T environment agent-harness update begin "*)
    running
    ! fails begin || { echo "The environment refused to begin the update: not ready." >&2; exit 1; }
    echo "Began the update." ;;
  "compose exec -T environment agent-harness update discard "*) running; echo "Discarded the snapshot." ;;
  "compose config --images environment") image_now ;;
  "compose stop environment")
    ! fails stop || { echo "stop failed" >&2; exit 1; }
    rm -f "$FAKE_STATE/running" ;;
  "compose run --rm -T environment update snapshot "* | "compose run --rm -T environment update restore "*)
    if [ -f "$FAKE_STATE/running" ]; then echo "An environment holds the database." >&2; exit 1; fi
    ! fails "$7" || { echo "The $7 failed." >&2; exit 1; } ;;
  "compose up -d environment")
    if [ -f "$FAKE_STATE/upped" ]; then ! fails up-again || exit 1; else : > "$FAKE_STATE/upped"; ! fails up || exit 1; fi
    image_now > "$FAKE_STATE/running"
    cat "$FAKE_STATE/clock" > "$FAKE_STATE/up-at" ;;
  "compose ps -q environment") [ ! -f "$FAKE_STATE/running" ] || echo container-for-tests ;;
  "inspect --format {{.RestartCount}} container-for-tests")
    count=0
    if [ "$(cat "$FAKE_STATE/running" 2>/dev/null)" = "$FAKE_TARGET" ]; then
      for at in \${FAKE_TARGET_RESTARTS:-}; do [ "$at" -gt "$(since_up)" ] || count=$((count + 1)); done
    fi
    echo "$count" ;;
  "pull "*)
    ! fails pull || { echo "Error response from daemon: manifest unknown" >&2; exit 1; }
    echo "$2" >> "$FAKE_STATE/images" ;;
  "tag "*) echo "$3" >> "$FAKE_STATE/images" ;;
  "image inspect "*) printf '%s@%s\\n' "\${5%:*}" "\${FAKE_PULLED_DIGEST:-$FAKE_DIGEST}" ;;
  "image ls "*) grep -v @ "$FAKE_STATE/images" | sort -u ;;
  "image rm "*) grep -vxF "$3" "$FAKE_STATE/images" > "$FAKE_STATE/images.new"; mv "$FAKE_STATE/images.new" "$FAKE_STATE/images" ;;
  *) echo "docker: unexpected call $*" >&2; exit 97 ;;
esac
`;

/** The pending update, as \`updates.status\` has it, in the state given. */
const pendingUpdate = (state: string, image: { reference: string; digest: string } | null = { reference: NEW, digest: DIGEST }) => ({
  state,
  updateId: UPDATE_ID,
  toVersion: "0.6.0",
  source: "channel",
  since: "2026-09-30T07:00:00.000Z",
  deferUntil: "2026-10-01T07:00:00.000Z",
  image,
  ...(state === "waiting" ? { waitsOn: { reason: "run-active", until: null } } : {}),
});

/** An \`updates.status\` document of the version given in a container, with the pending update given and an earlier update's outcome. */
const statusDocument = (pending: object, version = "0.5.0") => ({
  version,
  protocolVersion: 1,
  bundledClaudeCodeVersion: "2.1.283",
  manager: { kind: "outside", lastPoll: "2026-09-30T07:55:00.000Z" },
  releaseSource: { origin: "https://git.systemtech.dev:5526", repository: "david/agent-harness" },
  newest: "0.6.0",
  lastCheck: { at: "2026-09-30T07:30:00.000Z", result: "ok" },
  target: { version: "0.6.0", source: "channel" },
  passedOver: null,
  pending,
  lastOutcome: { outcome: "updated", updateId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", fromVersion: "0.4.0", toVersion: "0.5.0", at: "2026-09-20T07:00:00.000Z" },
  failedVersions: [],
  installed: [],
});

interface FixtureOptions {
  /** The pending update in the status the container answers; preset: the ready update to 0.6.0. */
  readonly pending?: object;
  /** The compose project's `.env` before the tick; preset: none, so the compose file's default image runs. */
  readonly envFile?: string;
  /** Use the machine's own flock rather than the fake. */
  readonly realFlock?: boolean;
}

interface Fixture {
  readonly composeDir: string;
  readonly composeFile: string;
  readonly state: string;
  readonly env: NodeJS.ProcessEnv;
  calls(): string[];
  /** The compose project's `.env`, or null when there is none. */
  envFile(): string | null;
  /** The image the container runs, or null while it is stopped. */
  running(): string | null;
  /** The images of the repository docker holds, by reference. */
  images(): string[];
  /** Forgets the calls so far. */
  forget(): void;
  /** What the container's update status answers from now on. */
  answer(pending: object, version?: string): void;
}

/** A compose project running 0.5.0 from the compose file's default image, with 0.4.0 and 0.5.0 pulled, and the fakes on PATH. */
const fixture = (options: FixtureOptions = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "agent-harness-host-updater-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const fakeBin = join(root, "fake-bin");
  const composeDir = join(root, "compose");
  const state = join(root, "state");
  for (const dir of [fakeBin, composeDir, state]) mkdirSync(dir, { recursive: true });
  const log = join(root, "calls.log");
  write(log, "");
  const composeFile = join(composeDir, "compose.yaml");
  write(composeFile, "name: agent-harness\n");
  if (options.envFile !== undefined) write(join(composeDir, ".env"), options.envFile);

  write(join(fakeBin, "docker"), FAKE_DOCKER, 0o755);
  write(join(fakeBin, "curl"), FAKE_CURL, 0o755);
  write(join(fakeBin, "date"), FAKE_DATE, 0o755);
  write(join(fakeBin, "sleep"), FAKE_SLEEP, 0o755);
  if (options.realFlock !== true) write(join(fakeBin, "flock"), FAKE_FLOCK, 0o755);

  write(join(state, "clock"), "1000000\n");
  write(join(state, "running"), `${OLD}\n`);
  write(join(state, "images"), `${OLDER}\n${OLD}\n`);
  const answer = (pending: object, version?: string) => write(join(state, "status.json"), `${JSON.stringify(statusDocument(pending, version), null, 2)}\n`);
  answer(options.pending ?? pendingUpdate("ready"));

  const env: NodeJS.ProcessEnv = {
    PATH: `${fakeBin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
    HOME: root,
    AGENT_HARNESS_COMPOSE_FILE: composeFile,
    FAKE_LOG: log,
    FAKE_STATE: state,
    FAKE_COMPOSE_FILE: composeFile,
    FAKE_COMPOSE_DIR: composeDir,
    FAKE_DEFAULT_IMAGE: OLD,
    FAKE_TARGET: NEW,
    FAKE_DIGEST: DIGEST,
    FAKE_HEALTH_URL: HEALTH,
  };
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return {
    composeDir,
    composeFile,
    state,
    env,
    calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean),
    envFile: () => read(join(composeDir, ".env")),
    running: () => read(join(state, "running"))?.trim() ?? null,
    images: () => (read(join(state, "images")) ?? "").split("\n").filter((line) => line !== "" && !line.includes("@")),
    forget: () => writeFileSync(log, ""),
    answer,
  };
};

interface Tick {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const tick = async (f: Fixture, env: NodeJS.ProcessEnv = {}, args: string[] = [], path = script): Promise<Tick> => {
  try {
    const { stdout, stderr } = await run("sh", [path, ...args], { env: { ...f.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
};

/**
 * The calls with the polling folded: a call repeated at once is kept once, and
 * so is a pair of calls repeated at once (the watch's probe and restart count).
 */
const folded = (calls: readonly string[]): string[] => {
  const out: string[] = [];
  for (const call of calls) {
    if (out.at(-1) === call) continue;
    out.push(call);
    const n = out.length;
    if (n >= 4 && out[n - 1] === out[n - 3] && out[n - 2] === out[n - 4]) out.splice(n - 2, 2);
  }
  return out;
};

describe.skipIf(process.platform === "win32")("scripts/host-updater.sh", () => {
  it("stops before any call when AGENT_HARNESS_UPDATER is 0", async () => {
    const f = fixture();
    const result = await tick(f, { AGENT_HARNESS_UPDATER: "0" });
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual([]);
    expect(result.stdout).toBe("");
    expect(f.running()).toBe(OLD);
  });

  it("prints its usage, naming its variables, for --help, and refuses an argument it does not take with exit 2, before any call", async () => {
    const f = fixture();
    const help = await tick(f, {}, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: host-updater\.sh/);
    for (const variable of ["AGENT_HARNESS_COMPOSE_FILE", "AGENT_HARNESS_HEALTH_URL", "AGENT_HARNESS_NOTIFY_COMMAND", "AGENT_HARNESS_UPDATER"]) {
      expect(help.stdout).toContain(variable);
    }
    const wrong = await tick(f, {}, ["--now"]);
    expect(wrong.code).toBe(2);
    expect(wrong.stderr).toContain("Usage: host-updater.sh");
    expect(f.calls()).toEqual([]);
  });

  it("exits at once, calling nothing more, when another tick holds the lock", async () => {
    const f = fixture();
    write(join(f.state, "lock-held"), "");
    const result = await tick(f);
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual(["flock -n 9"]);
    expect(result.stdout).toBe("");
  });

  describe("asks the container for its update status under the lock, and does nothing more unless the pending update is ready", () => {
    for (const pending of [{ state: "current" }, pendingUpdate("waiting"), pendingUpdate("draining")]) {
      it(pending.state, async () => {
        const f = fixture({ pending });
        const result = await tick(f);
        expect(result.code).toBe(0);
        expect(f.calls()).toEqual(["flock -n 9", STATUS]);
        expect(f.running()).toBe(OLD);
        expect(f.envFile()).toBeNull();
      });
    }
  });

  it("finds the compose file beside itself when AGENT_HARNESS_COMPOSE_FILE is not set", async () => {
    const f = fixture({ pending: { state: "current" } });
    const beside = join(f.composeDir, "host-updater.sh");
    copyFileSync(script, beside);
    const result = await tick(f, { AGENT_HARNESS_COMPOSE_FILE: "" }, [], beside);
    expect(result.code).toBe(0);
    expect(f.calls()).toEqual(["flock -n 9", STATUS]);
  });

  it("says so, and fails, when the container does not answer", async () => {
    const f = fixture();
    rmSync(join(f.state, "running"));
    const result = await tick(f);
    expect(result.code).toBe(1);
    expect(f.calls()).toEqual(["flock -n 9", STATUS]);
    expect(result.stdout).toContain("did not answer update status");
  });

  /** A notify command that keeps each outcome and message it is given. */
  const NOTIFY = 'printf "%s|%s\\n" "$AGENT_HARNESS_OUTCOME" "$AGENT_HARNESS_MESSAGE" >> "$FAKE_STATE/notified"';
  const notified = (f: Fixture) => (existsSync(join(f.state, "notified")) ? readFileSync(join(f.state, "notified"), "utf8").split("\n").filter(Boolean) : []);
  const clock = (f: Fixture) => Number(readFileSync(join(f.state, "clock"), "utf8"));
  const upAt = (f: Fixture) => Number(readFileSync(join(f.state, "up-at"), "utf8"));

  it("updates a ready update: pulls and checks the image, begins, stops, snapshots on the old image, recreates on the target, waits for ready, watches ten minutes, discards the snapshot and removes the older images", async () => {
    const f = fixture();
    const result = await tick(f, { AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual(
      [
        `Pulled ${NEW} and checked its digest; beginning update ${UPDATE_ID} from 0.5.0 to 0.6.0.`,
        "The environment is draining; stopping its container, which waits out the drain.",
        `Stopped; snapshotting the database on ${OLD}.`,
        `Recreating the container on ${NEW}; waiting up to 120 seconds for it to say ready.`,
        "0.6.0 says ready; watching it for 10 minutes.",
        `Updated from 0.5.0 to 0.6.0 (update ${UPDATE_ID}): the snapshot is discarded, and images older than ${OLD} are removed.`,
      ].map((line) => `2026-09-30T08:00:00Z host-updater: ${line}`),
    );
    expect(folded(f.calls())).toEqual([
      "flock -n 9",
      STATUS,
      IMAGES,
      PULL,
      TAG,
      CHECK,
      BEGIN,
      STOP,
      snapshotOn(OLD),
      upOn(NEW),
      PROBE,
      CONTAINER,
      RESTARTS,
      PROBE,
      DISCARD,
      LIST_IMAGES,
      `docker image rm ${OLDER}`,
    ]);
    expect(clock(f) - upAt(f)).toBeGreaterThanOrEqual(600);
    expect(f.running()).toBe(NEW);
    expect(f.envFile()).toBe(`AGENT_HARNESS_IMAGE=${NEW}\nAGENT_HARNESS_PREVIOUS_IMAGE=${OLD}\n`);
    expect(f.images().sort()).toEqual([OLD, NEW]);
    expect(notified(f)).toEqual([`updated|Updated from 0.5.0 to 0.6.0 (update ${UPDATE_ID}): the snapshot is discarded, and images older than ${OLD} are removed.`]);
  });
  /** The log lines of a tick, without their time. */
  const logged = (t: Tick) => t.stdout.split("\n").filter(Boolean).map((line) => line.replace(/^\S+ host-updater: /, ""));

  it("writes one line per state change across ticks, so a tick that finds what the last one found writes nothing", async () => {
    const f = fixture();
    expect((await tick(f)).code).toBe(0);
    f.answer({ state: "current" }, "0.6.0");
    expect(logged(await tick(f))).toEqual(["Nothing to update: the environment runs 0.6.0."]);
    expect(logged(await tick(f))).toEqual([]);
    f.answer(pendingUpdate("waiting"), "0.6.0");
    expect(logged(await tick(f))).toEqual(["The update to 0.6.0 is waiting, not ready for the host-side updater."]);
    expect(logged(await tick(f))).toEqual([]);
  });

  it("keeps the .env file's other lines, and the image the updater's own environment names does not override the file's", async () => {
    const f = fixture({ envFile: `COMPOSE_PROFILES=tools\nAGENT_HARNESS_IMAGE=${OLD}\nAGENT_HARNESS_PREVIOUS_IMAGE=${OLDER}\n` });
    expect((await tick(f, { AGENT_HARNESS_IMAGE: "someone/else:1.0.0" })).code).toBe(0);
    expect(f.calls()).toContain(snapshotOn(OLD));
    expect(f.envFile()).toBe(`COMPOSE_PROFILES=tools\nAGENT_HARNESS_IMAGE=${NEW}\nAGENT_HARNESS_PREVIOUS_IMAGE=${OLD}\n`);
    expect(f.images().sort()).toEqual([OLD, NEW]);
  });

  it("waits while the target says starting, and takes one that says ready at 120 seconds", async () => {
    const f = fixture();
    expect((await tick(f, { FAKE_TARGET_READY_AFTER: "120" })).code).toBe(0);
    expect(f.running()).toBe(NEW);
    expect(f.calls().filter((call) => call === PROBE).length).toBeGreaterThan(20);
  });

  describe("leaves the container running and untouched when the image does not pull or is not the manifest's, and says so once however many ticks it fails", () => {
    const cases = [
      { name: "a failed pull", env: { FAKE_FAIL: "pull" }, calls: [PULL], why: `docker pull ${REPOSITORY}@${DIGEST} failed` },
      { name: "another digest", env: { FAKE_PULLED_DIGEST: OTHER_DIGEST }, calls: [PULL, TAG, CHECK], why: `${NEW} is not the release manifest's ${DIGEST}` },
      { name: "no image", pending: pendingUpdate("ready", null), calls: [], why: "the ready update names no image to pull" },
      { name: "a digest that is none", pending: pendingUpdate("ready", { reference: NEW, digest: "sha256:abc" }), calls: [], why: "the ready update names no image digest (sha256:abc)" },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const f = fixture(c.pending === undefined ? {} : { pending: c.pending });
        const env = { ...c.env, AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY };
        const first = await tick(f, env);
        expect(first.code).toBe(1);
        expect(f.calls()).toEqual(["flock -n 9", STATUS, IMAGES, ...c.calls]);
        expect(f.running()).toBe(OLD);
        expect(f.envFile()).toBeNull();
        const message = `Update ${UPDATE_ID} to 0.6.0 is ready, but its image did not pull: ${c.why}. The container runs as it was.`;
        expect(logged(first)).toEqual([message]);
        expect(notified(f)).toEqual([`pull-failed|${message}`]);
        const again = await tick(f, env);
        expect(again.code).toBe(1);
        expect(again.stdout).toBe("");
        expect(notified(f)).toHaveLength(1);
      });
    }
  });

  it("leaves the container running and untouched when the environment refuses to begin the update", async () => {
    const f = fixture();
    const result = await tick(f, { FAKE_FAIL: "begin", AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
    expect(result.code).toBe(1);
    expect(f.calls()).toEqual(["flock -n 9", STATUS, IMAGES, PULL, TAG, CHECK, BEGIN]);
    expect(f.running()).toBe(OLD);
    expect(f.envFile()).toBeNull();
    expect(notified(f)).toEqual([`not-begun|The environment refused to begin update ${UPDATE_ID} to 0.6.0, and runs as it was.`]);
  });

  describe("starts the old image again as it was when the stop or the snapshot fails, before the target is written", () => {
    for (const [step, last] of [
      ["stop", [STOP]],
      ["snapshot", [STOP, snapshotOn(OLD)]],
    ] as const) {
      it(step, async () => {
        const f = fixture();
        const result = await tick(f, { FAKE_FAIL: step, AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
        expect(result.code).toBe(1);
        expect(f.calls()).toEqual(["flock -n 9", STATUS, IMAGES, PULL, TAG, CHECK, BEGIN, ...last, upOn(OLD)]);
        expect(f.running()).toBe(OLD);
        expect(f.envFile()).toBeNull();
        expect(notified(f)).toEqual([
          `abandoned|Update ${UPDATE_ID} to 0.6.0 was not carried out: ${step === "stop" ? "docker compose stop" : "update snapshot"} failed. 0.5.0 was started again as it was.`,
        ]);
      });
    }
  });

  const UPDATE_UP_TO_THE_TARGET = ["flock -n 9", STATUS, IMAGES, PULL, TAG, CHECK, BEGIN, STOP, snapshotOn(OLD), upOn(NEW)];
  const ROLLED_BACK_TO_THE_OLD = (stage: string, reason: string) => [STOP, restoreOn(OLD, stage, reason), upOn(OLD), PROBE, DISCARD];

  describe("rolls a target back that does not say ready at the target within 120 seconds: stop, restore on the previous image, the previous reference back, up -d, health", () => {
    for (const [name, env] of [
      ["one still starting", { FAKE_TARGET_READY_AFTER: "125" }],
      ["one ready at another version", { FAKE_TARGET_SAYS_VERSION: "0.5.0" }],
    ] as const) {
      it(name, async () => {
        const f = fixture({ envFile: `AGENT_HARNESS_IMAGE=${OLD}\nAGENT_HARNESS_PREVIOUS_IMAGE=${OLDER}\n` });
        const result = await tick(f, { ...env, AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
        expect(result.code).toBe(1);
        expect(folded(f.calls())).toEqual([...UPDATE_UP_TO_THE_TARGET, PROBE, ...ROLLED_BACK_TO_THE_OLD("trial", "health")]);
        expect(f.running()).toBe(OLD);
        expect(f.envFile()).toBe(`AGENT_HARNESS_IMAGE=${OLD}\nAGENT_HARNESS_PREVIOUS_IMAGE=${OLDER}\n`);
        expect(logged(result).slice(-2)).toEqual([
          `0.6.0 did not say ready at ${HEALTH} within 120 seconds; rolling back to ${OLD}.`,
          `Rolled update ${UPDATE_ID} back from 0.6.0 to 0.5.0 (trial: health): the snapshot is restored and ${OLD} runs again.`,
        ]);
        expect(notified(f)).toEqual([`rolled-back|${logged(result).at(-1) ?? ""}`]);
      });
    }
  });

  it("rolls back a target whose container does not start, at the trial", async () => {
    const f = fixture();
    const result = await tick(f, { FAKE_FAIL: "up" });
    expect(result.code).toBe(1);
    expect(folded(f.calls())).toEqual([...UPDATE_UP_TO_THE_TARGET, ...ROLLED_BACK_TO_THE_OLD("trial", "start")]);
    expect(f.running()).toBe(OLD);
    expect(f.envFile()).toBe(`AGENT_HARNESS_IMAGE=${OLD}\n`);
  });

  describe("rolls back a crash loop in the ten-minute watch", () => {
    for (const [name, env, reason, line] of [
      ["three restarts", { FAKE_TARGET_RESTARTS: "200 300 400" }, "restarts", "0.6.0 restarted 3 times in its watch"],
      ["two minutes not ready", { FAKE_TARGET_DOWN_FROM: "300" }, "not-ready", `0.6.0 was not ready at ${HEALTH} for 120 seconds in its watch`],
    ] as const) {
      it(name, async () => {
        const f = fixture();
        const result = await tick(f, { ...env, AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
        expect(result.code).toBe(1);
        // The watch ends at the restart count that makes three, or at the probe that makes two minutes.
        const lastPoll = reason === "restarts" ? [RESTARTS] : [];
        expect(folded(f.calls())).toEqual([...UPDATE_UP_TO_THE_TARGET, PROBE, CONTAINER, RESTARTS, PROBE, ...lastPoll, ...ROLLED_BACK_TO_THE_OLD("crash-loop", reason)]);
        expect(f.running()).toBe(OLD);
        expect(f.envFile()).toBe(`AGENT_HARNESS_IMAGE=${OLD}\n`);
        expect(logged(result)).toContain(`${line}; rolling back to ${OLD}.`);
        expect(notified(f)).toEqual([`rolled-back|Rolled update ${UPDATE_ID} back from 0.6.0 to 0.5.0 (crash-loop: ${reason}): the snapshot is restored and ${OLD} runs again.`]);
      });
    }

    it("but not two restarts, nor a target not ready for less than two minutes", async () => {
      const f = fixture();
      expect((await tick(f, { FAKE_TARGET_RESTARTS: "200 300", FAKE_TARGET_DOWN_FROM: "550" })).code).toBe(0);
      expect(f.running()).toBe(NEW);
    });
  });

  it("leaves the container stopped, and runs no up -d, when the restore fails, since nothing may open a database whose restore is marked", async () => {
    const f = fixture();
    const result = await tick(f, { FAKE_TARGET_READY_AFTER: "125", FAKE_FAIL: "restore", AGENT_HARNESS_NOTIFY_COMMAND: NOTIFY });
    expect(result.code).toBe(1);
    expect(folded(f.calls())).toEqual([...UPDATE_UP_TO_THE_TARGET, PROBE, STOP, restoreOn(OLD, "trial", "health")]);
    expect(f.running()).toBeNull();
    expect(notified(f)).toEqual([
      `rollback-failed|The rollback of update ${UPDATE_ID} from 0.6.0 to ${OLD} (trial: health) failed: update restore on ${OLD} failed, so the container is left stopped. See When a rollback fails in docs/host-updater.md.`,
    ]);
  });

  it("says the rollback failed when the previous version does not say ready after its restore", async () => {
    const f = fixture();
    const result = await tick(f, { FAKE_TARGET_READY_AFTER: "125", FAKE_FAIL: "up-again" });
    expect(result.code).toBe(1);
    expect(folded(f.calls())).toEqual([...UPDATE_UP_TO_THE_TARGET, PROBE, STOP, restoreOn(OLD, "trial", "health"), upOn(OLD)]);
    expect(logged(result).at(-1)).toContain(`docker compose up -d on ${OLD} failed`);
  });

  it("goes on when the notify command fails, saying so on standard error", async () => {
    const f = fixture();
    const result = await tick(f, { AGENT_HARNESS_NOTIFY_COMMAND: "exit 3" });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("AGENT_HARNESS_NOTIFY_COMMAND failed for the outcome updated.");
    expect(f.running()).toBe(NEW);
  });

  const hasFlock = spawnSync("sh", ["-c", "command -v flock && command -v mkfifo"]).status === 0;
  it.skipIf(!hasFlock)("runs one tick at a time under the machine's own flock: a tick while another is under way exits at once", async () => {
    const f = fixture({ realFlock: true, pending: { state: "current" } });
    await run("mkfifo", [join(f.state, "hold")]);
    const first = tick(f, { FAKE_HOLD: "1" });
    await vi.waitFor(() => expect(f.calls()).toEqual([STATUS]), { timeout: 20_000, interval: 50 });
    const second = await tick(f);
    expect(second.code).toBe(0);
    expect(second.stdout).toBe("");
    expect(f.calls()).toEqual([STATUS]);
    await writeFile(join(f.state, "hold"), "go\n");
    const done = await first;
    expect(done.code).toBe(0);
    expect(logged(done)).toEqual(["Nothing to update: the environment runs 0.5.0."]);
  });
  it("is documented where the compose file's header points: installing with cron or a systemd timer, its docker login, every variable its usage names, and what to do when a rollback fails", async () => {
    const docs = readFileSync(join(import.meta.dirname, "..", "docs", "host-updater.md"), "utf8");
    const help = await tick(fixture(), {}, ["--help"]);
    const variables = new Set([...help.stdout.matchAll(/AGENT_HARNESS_[A-Z_]+/g)].map((match) => match[0]));
    expect(variables.size).toBe(6);
    for (const variable of variables) expect(docs, variable).toContain(variable);
    for (const phrase of ["crontab -e", "OnCalendar=", "docker login git.systemtech.dev:5526", "read:package", "## When a rollback fails"]) {
      expect(docs, phrase).toContain(phrase);
    }
  });
});
