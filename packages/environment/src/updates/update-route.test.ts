import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STAGING_DIRECTORY, UPDATE_PATH, UpdateAnswer, UpdateError, type ClientSessionCredential } from "@agent-harness/contracts";
import { describe, expect, it } from "vitest";
import { serverArtefact, unpackedServerArtefact } from "../../test/artefacts.js";
import { useCleanups } from "../../test/cleanups.js";
import { startTestEnvironment, type TestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { testLauncher, type TestLauncherOptions } from "../../test/launcher.js";
import { startFakeReleaseSource, type FakeRelease, type FakeReleaseSource } from "../../test/release-source.js";
import type { WireClient } from "../../test/wire-client.js";

/**
 * `POST /api/update` (launcher-update spec, "Across a protocol gap"; #353)
 * through the primary seam: the in-process environment over real HTTP, its
 * release source the fake one, its launcher scripted. The route's request and
 * answer are read as the contracts' `UpdateRequest`, `UpdateAnswer` and
 * `UpdateError` fix them, and nothing here reads the wire's protocol version:
 * a client of any version may ask an environment of any other.
 */

const { onCleanup, tempDir } = useCleanups();

/** The version the tests' environments run as. */
const RUNNING = "0.4.1";

/** Where the route is, on the environment's own address. */
const routeOf = (t: TestEnvironment): string => `http://${t.address.host}:${t.address.port}${UPDATE_PATH}`;

/** What the route answered: its status, and its body as the contracts read it. Each request closes its connection, so none is reset by the server closing an idle one. */
const post = async (t: TestEnvironment, token: string | undefined, body: unknown) => {
  const response = await fetch(routeOf(t), {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close", ...(token !== undefined && { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, headers: response.headers, body: (await response.json()) as unknown };
};

/** The refusal an answer is, read as `UpdateError`: the route never answers another shape. */
const refusalOf = (answer: { readonly body: unknown }): UpdateError => UpdateError.parse(answer.body);

const start = async (fake: FakeReleaseSource, options: TestEnvironmentOptions & { readonly launch?: TestLauncherOptions } = {}) => {
  const { launch, ...rest } = options;
  const t = await startTestEnvironment({
    harnessVersion: RUNNING,
    launcher: testLauncher({ present: true, ...launch }),
    releaseSource: fake.source,
    forgeFetch: fake.forge.fetch,
    ...rest,
  });
  onCleanup(() => t.close());
  return t;
};

/** An environment running RUNNING under a launcher, whose release source is a fake one it has the forge account for; `admin` is the token of a paired client session holding it. */
const withReleases = async (options: Parameters<typeof start>[1] = {}) => {
  const fake = await startFakeReleaseSource();
  onCleanup(() => fake.forge.close());
  const t = await start(fake, options);
  const client = await t.client();
  await fake.grantAccess(client);
  const admin: ClientSessionCredential = await t.pair({ kind: "desktop", scopes: ["read", "admin"] });
  return { fake, t, client, admin: admin.token };
};

/** Idle a minute in: the idle window set to a minute, past the one its start holds (#445), before the first scheduled check at two. */
const idleNow = async (t: TestEnvironment, client: WireClient): Promise<void> => {
  await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.idleWindowMinutes": 1 } });
  t.clock.advance(60_000);
};

const release = (version: string): FakeRelease => ({ version, artefact: readFileSync(serverArtefact(tempDir("agent-harness-artefact-"), version)) });

const updateNotices = (t: TestEnvironment) =>
  t.env.log
    .readStream({ kinds: ["environment"] })
    .filter((event) => event.type.startsWith("environment.update"))
    .map((event) => ({ type: event.type, payload: event.payload }));

describe("POST /api/update with a token holding admin", () => {
  it("applies the version as updates.apply does when idle, answering the update id and the target", async () => {
    const { fake, t, client, admin } = await withReleases();
    fake.publish(release("0.5.0"));
    // A run under way, so the update waits, as updates.apply with when idle would leave it.
    t.runs.start("r1");
    t.runs.running("r1");

    const answered = await post(t, admin, { version: "0.5.0" });

    expect(answered.status).toBe(200);
    const taken = UpdateAnswer.parse(answered.body);
    expect(taken).toEqual({ updateId: expect.any(String) as unknown as string, toVersion: "0.5.0" });
    expect(updateNotices(t)).toEqual([expect.objectContaining({ type: "environment.update-pending", payload: expect.objectContaining({ ...taken, source: "request" }) as unknown })]);
    expect((await client.request("updates.status", {})).pending).toMatchObject({ state: "waiting", updateId: taken.updateId, toVersion: "0.5.0" });
  });

  it("drains at once when the environment is idle, as updates.apply with when idle does, and says who asked", async () => {
    const { fake, t, client, admin } = await withReleases();
    fake.publish(release("0.5.0"));
    await idleNow(t, client);

    const taken = UpdateAnswer.parse((await post(t, admin, { version: "0.5.0" })).body);

    expect(updateNotices(t).map((notice) => notice.type)).toEqual(["environment.update-pending", "environment.update-started"]);
    expect(updateNotices(t)[1]?.payload).toMatchObject({ updateId: taken.updateId, toVersion: "0.5.0", cause: "idle" });
    expect(t.env.readiness()).toBe("draining");
  });

  it("takes an artefact path from a local client session: an archive, or the folder it is unpacked in, as the desktop carries it (#789)", async () => {
    for (const artefactPath of [serverArtefact(tempDir(), "0.5.0"), unpackedServerArtefact(tempDir(), "0.5.0")]) {
      const { t } = await withReleases();
      const local = await t.bootstrap("desktop");

      const answered = await post(t, local.token, { version: "0.5.0", artefactPath });

      expect(answered.status, artefactPath).toBe(200);
      expect(UpdateAnswer.parse(answered.body)).toMatchObject({ toVersion: "0.5.0" });
    }
  });

  it("answers while the wire refuses the client for a protocol it does not speak", async () => {
    const { fake, t, admin } = await withReleases();
    fake.publish(release("0.5.0"));
    // A protocol far past any this environment speaks: the newer client of an older environment.
    const socket = await t.open();
    socket.send({ type: "auth", token: admin, protocolVersion: 999_999, clientKind: "desktop", harnessVersion: "9.9.9" });
    expect((await socket.closed).bye).toMatchObject({ reason: "protocol" });

    const answered = await post(t, admin, { version: "0.5.0" });

    expect(answered.status).toBe(200);
    UpdateAnswer.parse(answered.body);
  });
});

describe("POST /api/update refuses", () => {
  it("a request with no token, or a token that is none, as unauthorized", async () => {
    const { t } = await withReleases();
    for (const token of [undefined, "token-for-tests"]) {
      const answered = await post(t, token, { version: "0.5.0" });
      expect(answered.status).toBe(401);
      expect(answered.headers.get("www-authenticate")).toBe("Bearer");
      expect(refusalOf(answered)).toMatchObject({ code: "unauthorized" });
    }
    expect(updateNotices(t)).toEqual([]);
  });

  it("a token that was revoked as unauthorized naming it", async () => {
    const { t } = await withReleases();
    const revoked = await t.pair({ kind: "desktop", scopes: ["read", "admin"] });
    expect(t.env.clientSessions.revoke(revoked.clientSessionId)).toBe(true);

    const gone = await post(t, revoked.token, { version: "0.5.0" });

    expect(gone.status).toBe(401);
    expect(refusalOf(gone)).toMatchObject({ code: "unauthorized", message: expect.stringContaining("revoked") as unknown as string });
    expect(updateNotices(t)).toEqual([]);
  });

  // Thirty days on the manual clock run every minute's sweep in one go, which blocks the process for seconds under load:
  // its own test, with the time allowed for that, and no request before the advance to have its connection reset meanwhile.
  it("a token that expired as unauthorized naming it", { timeout: 120_000 }, async () => {
    const t = await startTestEnvironment({ harnessVersion: RUNNING, launcher: testLauncher({ present: true }) });
    onCleanup(() => t.close());
    const { token } = await t.pair({ kind: "desktop", scopes: ["read", "admin"] });
    t.clock.advance(31 * 24 * 60 * 60 * 1000);

    const expired = await post(t, token, { version: "0.5.0" });

    expect(expired.status).toBe(401);
    expect(refusalOf(expired)).toMatchObject({ code: "unauthorized", message: expect.stringContaining("expired") as unknown as string });
    expect(updateNotices(t)).toEqual([]);
  });

  it("a token without admin as forbidden naming the scope, before its body is read", async () => {
    const { t } = await withReleases();
    const reader = await t.pair({ kind: "desktop", scopes: ["read"] });

    for (const body of [{ version: "0.5.0" }, "not json"]) {
      const answered = await post(t, reader.token, body);
      expect(answered.status).toBe(403);
      expect(refusalOf(answered)).toMatchObject({ code: "forbidden", data: { scope: "admin" } });
    }
    expect(updateNotices(t)).toEqual([]);
  });

  it("an artefact path from a paired session as forbidden with reason local, an archive or a folder, staging nothing", async () => {
    const { t, admin } = await withReleases();

    for (const artefactPath of [serverArtefact(tempDir(), "0.5.0"), unpackedServerArtefact(tempDir(), "0.5.0")]) {
      const answered = await post(t, admin, { version: "0.5.0", artefactPath });

      expect(answered.status, artefactPath).toBe(403);
      expect(refusalOf(answered)).toMatchObject({ code: "forbidden", data: { scope: "admin", reason: "local" } });
    }
    expect(t.launcher.received.filter((message) => message.type === "install?")).toEqual([]);
    expect(existsSync(join(t.dataDir, STAGING_DIRECTORY))).toBe(false);
    expect(updateNotices(t)).toEqual([]);
  });

  it("a body that is not JSON, not a request, or too large, as invalid_params", async () => {
    const { t, admin } = await withReleases();
    const oversized = JSON.stringify({ version: "0.5.0", artefactPath: "x".repeat(20_000) });
    for (const [body, status] of [
      ["not json", 400],
      [{}, 400],
      [{ version: "v0.5.0" }, 400],
      [{ version: "0.5.0", artefactPath: "" }, 400],
      [oversized, 413],
    ] as const) {
      const answered = await post(t, admin, body);
      expect(answered.status, JSON.stringify(body).slice(0, 40)).toBe(status);
      expect(refusalOf(answered)).toMatchObject({ code: "invalid_params" });
    }
  });

  it("what updates.apply refuses, at the status of its code with its reason: current 409, unknown release 404, pinned 409, launcher refusal 409 install", async () => {
    const { fake, t, client, admin } = await withReleases({ launch: { install: (request) => (request.version === "0.5.1" ? { type: "refused", reason: "disk" } : { type: "installed" }) } });
    fake.publish(release("0.4.5"), release("0.5.1"));
    fake.absent("0.9.9");

    const current = await post(t, admin, { version: RUNNING });
    expect(current.status).toBe(409);
    expect(refusalOf(current)).toMatchObject({ code: "conflict", data: { reason: "current" } });

    const unknown = await post(t, admin, { version: "0.9.9" });
    expect(unknown.status).toBe(404);
    expect(refusalOf(unknown)).toMatchObject({ code: "not_found", message: expect.stringContaining("0.9.9") as unknown as string });

    const installed = await post(t, admin, { version: "0.5.1" });
    expect(installed.status).toBe(409);
    expect(refusalOf(installed)).toMatchObject({ code: "conflict", data: { reason: "install", launcherReason: "disk" } });

    await client.request("updates.settings.set", { commandId: randomUUID(), values: { "updates.pinnedVersion": "0.4.5" } });
    const pinned = await post(t, admin, { version: "0.5.1" });
    expect(pinned.status).toBe(409);
    expect(refusalOf(pinned)).toMatchObject({ code: "conflict", data: { reason: "pinned" } });
    expect(updateNotices(t).filter((notice) => notice.type === "environment.update-pending")).toEqual([]);
  });

  it("an environment with no launcher as conflict no_launcher", async () => {
    const { fake, t, admin } = await withReleases({ launch: { present: false } });
    fake.publish(release("0.5.0"));

    const answered = await post(t, admin, { version: "0.5.0" });

    expect(answered.status).toBe(409);
    expect(refusalOf(answered)).toMatchObject({ code: "conflict", data: { reason: "no_launcher" } });
  });

  it("a draining environment as unavailable, naming it", async () => {
    const { fake, t, client, admin } = await withReleases();
    fake.publish(release("0.5.0"));
    await idleNow(t, client);
    expect((await post(t, admin, { version: "0.5.0" })).status).toBe(200);
    expect(t.env.readiness()).toBe("draining");

    const again = await post(t, admin, { version: "0.5.0" });

    expect(again.status).toBe(503);
    expect(refusalOf(again)).toMatchObject({ code: "unavailable", data: { readiness: "draining" } });
  });

  it("a GET, as the route table refuses every method the route does not take", async () => {
    const { t } = await withReleases();
    const answered = await fetch(routeOf(t));
    expect(answered.status).toBe(405);
    expect(answered.headers.get("allow")).toBe("POST");
  });
});
