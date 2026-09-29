import { describe, expect, it, vi } from "vitest";
import { useCleanups } from "../../test/cleanups.js";
import { MANUAL_CLOCK_START } from "../../test/clock.js";
import { startFakeOpenBao, type FakeLogin, type FakeOpenBao } from "../../test/fake-openbao.js";
import { startTestEnvironment, type TestEnvironmentOptions } from "../../test/helper.js";
import { ROLE_ID, SECRET_ID, added, approle } from "../../test/key-manager-connections.js";
import { WAIT_MS, type WireClient } from "../../test/wire-client.js";

/**
 * Staying signed in (#369; key-managers spec, "Providers" and "Run tokens";
 * ADR 0028) through the primary seam: an in-process environment beside the
 * fake OpenBao on the manual clock, whose logins have times to live, maximum
 * lives and periods, and whose credentials can be refused on demand, and
 * the fake adapter reporting what each process was spawned with. What is
 * asserted is what the fake OpenBao issued, renewed, revoked and was asked,
 * what holders were given, and what `keyManagers.list` answers; never the
 * registry's own state.
 */

const { onCleanup } = useCleanups();

const MINUTE = 60_000;

/** The manual clock's start, moved on by `ms`, as a timestamp. */
const after = (ms: number): string => new Date(Date.parse(MANUAL_CLOCK_START) + ms).toISOString();

/** Waits for something the environment does in the background, with the test's own timeout as the real bound: never a short wall-clock budget. */
const eventually = (assertion: () => void): Promise<void> => vi.waitFor(assertion, { timeout: WAIT_MS });

/** The fake's policy that lets a login mint run tokens, at the token-create path and the role `runs`'s. */
const MINTER = `path "auth/token/create" { capabilities = ["update"] }
path "auth/token/create/runs" { capabilities = ["update"] }`;

/** An environment beside a fake OpenBao on its clock, whose AppRole signs the test's role id and secret id in as `login` says, with default and minter. */
const withOpenBao = async (login: Omit<FakeLogin, "policies">, options: TestEnvironmentOptions = {}) => {
  const t = await startTestEnvironment(options);
  onCleanup(() => t.close());
  const bao = await startFakeOpenBao({ now: () => t.clock.now() });
  onCleanup(() => bao.close());
  bao.policy("minter", MINTER);
  bao.approle(ROLE_ID, SECRET_ID, { policies: ["default", "minter"], ...login });
  return { t, bao, client: await t.client() };
};

/** A connection signed in by AppRole on `bao`, with its CA pinned. */
const connected = (client: WireClient, bao: FakeOpenBao) => added(client, { address: bao.address, ca: bao.ca, credential: approle() });

describe("a login", () => {
  it("is renewed at two thirds of its time to live, each time by the time to live it was created with, and so outlives it", async () => {
    const { t, bao, client } = await withOpenBao({ ttlSeconds: 3600 });
    await connected(client, bao);
    const [login = ""] = bao.minted;

    t.clock.advance(40 * MINUTE);
    await eventually(() => expect(bao.renewals(login)).toEqual([after(40 * MINUTE)]));
    t.clock.advance(40 * MINUTE);
    await eventually(() => expect(bao.renewals(login)).toEqual([after(40 * MINUTE), after(80 * MINUTE)]));

    expect(bao.live(login)).toBe(true);
    expect(bao.minted).toEqual([login]);
  });
});
